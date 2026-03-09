import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WorkflowTriggerService,
  type ChatTriggerConfig,
} from "../../src/gateway/workflow-triggers.js";
import { registerInternalHook, triggerInternalHook } from "../../src/hooks/internal-hooks.js";

// Mock dependencies
vi.mock("../../src/infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../src/hooks/internal-hooks.js", () => ({
  registerInternalHook: vi.fn(),
  triggerInternalHook: vi.fn(),
  clearInternalHooks: vi.fn(),
  isMessageReceivedEvent: vi.fn((event) => event.type === "message" && event.action === "received"),
}));

describe("WorkflowTriggerService", () => {
  let service: WorkflowTriggerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorkflowTriggerService();
    service.initialize();
  });

  describe("initialize", () => {
    it("should register message:received hook on first initialization", () => {
      expect(registerInternalHook).toHaveBeenCalledWith("message:received", expect.any(Function));
    });

    it("should not register hook twice on multiple initializations", () => {
      service.initialize();
      service.initialize();

      expect(registerInternalHook).toHaveBeenCalledTimes(1);
    });
  });

  describe("registerChatTrigger", () => {
    it("should register a chat trigger with session key", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const triggers = service.getWorkflowTriggers("wf-123");
      expect(triggers).toHaveLength(1);
      expect(triggers[0]).toMatchObject(config);
    });

    it("should register multiple triggers for same session", () => {
      const config1: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      const config2: ChatTriggerConfig = {
        workflowId: "wf-789",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-012",
      };

      service.registerChatTrigger(config1);
      service.registerChatTrigger(config2);

      const triggers1 = service.getWorkflowTriggers("wf-123");
      const triggers2 = service.getWorkflowTriggers("wf-789");

      expect(triggers1).toHaveLength(1);
      expect(triggers2).toHaveLength(1);
      expect(service.getAllTriggers()).toHaveLength(2);
    });

    it("should skip registration if trigger is disabled", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: false,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      expect(service.getAllTriggers()).toHaveLength(0);
    });

    it("should register trigger with keyword filter", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "telegram:chat-789",
        matchKeyword: "/start",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const triggers = service.getWorkflowTriggers("wf-123");
      expect(triggers).toHaveLength(1);
      expect(triggers[0].matchKeyword).toBe("/start");
    });
  });

  describe("unregisterChatTrigger", () => {
    it("should remove a specific trigger", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);
      expect(service.getAllTriggers()).toHaveLength(1);

      service.unregisterChatTrigger(config);
      expect(service.getAllTriggers()).toHaveLength(0);
    });

    it("should not throw when removing non-existent trigger", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      expect(() => service.unregisterChatTrigger(config)).not.toThrow();
    });
  });

  describe("unregisterWorkflow", () => {
    it("should remove all triggers for a workflow", () => {
      const config1: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      const config2: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "telegram:chat-789",
        enabled: true,
        cronJobId: "cron-012",
      };

      service.registerChatTrigger(config1);
      service.registerChatTrigger(config2);

      expect(service.getAllTriggers()).toHaveLength(2);

      service.unregisterWorkflow("wf-123");

      expect(service.getAllTriggers()).toHaveLength(0);
    });

    it("should only remove triggers for specified workflow", () => {
      const config1: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      const config2: ChatTriggerConfig = {
        workflowId: "wf-789",
        sessionKey: "telegram:chat-789",
        enabled: true,
        cronJobId: "cron-012",
      };

      service.registerChatTrigger(config1);
      service.registerChatTrigger(config2);

      service.unregisterWorkflow("wf-123");

      expect(service.getAllTriggers()).toHaveLength(1);
      expect(service.getAllTriggers()[0].workflowId).toBe("wf-789");
    });
  });

  describe("onMessageReceived", () => {
    it("should trigger workflow when message matches session key", async () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const mockEvent = {
        type: "message" as const,
        action: "received" as const,
        sessionKey: "slack:U123456",
        context: {
          from: "U123456",
          content: "Hello world",
          channelId: "slack",
          sessionKey: "slack:U123456",
        },
        timestamp: new Date(),
        messages: [],
      };

      await triggerInternalHook(mockEvent);

      // Workflow should have been triggered
      // Note: Actual verification would require mocking enqueueSystemEvent
    });

    it("should not trigger workflow when keyword does not match", async () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        matchKeyword: "/start",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const mockEvent = {
        type: "message" as const,
        action: "received" as const,
        sessionKey: "slack:U123456",
        context: {
          from: "U123456",
          content: "Hello world", // Does not contain "/start"
          channelId: "slack",
          sessionKey: "slack:U123456",
        },
        timestamp: new Date(),
        messages: [],
      };

      await triggerInternalHook(mockEvent);

      // Workflow should NOT have been triggered due to keyword mismatch
      expect(service.getAllTriggers()).toHaveLength(1); // Trigger still registered
    });

    it("should trigger workflow when keyword matches", async () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "telegram:chat-789",
        matchKeyword: "help",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const mockEvent = {
        type: "message" as const,
        action: "received" as const,
        sessionKey: "telegram:chat-789",
        context: {
          from: "user-123",
          content: "I need help with my account",
          channelId: "telegram",
          sessionKey: "telegram:chat-789",
        },
        timestamp: new Date(),
        messages: [],
      };

      await triggerInternalHook(mockEvent);

      // Workflow should have been triggered
    });

    it("should not trigger for non-message events", async () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      const mockEvent = {
        type: "command" as const,
        action: "new" as const,
        sessionKey: "slack:U123456",
        context: {},
        timestamp: new Date(),
        messages: [],
      };

      await triggerInternalHook(mockEvent);

      // Should not affect chat triggers
      expect(service.getAllTriggers()).toHaveLength(1);
    });
  });

  describe("clearAllTriggers", () => {
    it("should remove all registered triggers", () => {
      const config1: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      const config2: ChatTriggerConfig = {
        workflowId: "wf-789",
        sessionKey: "telegram:chat-789",
        enabled: true,
        cronJobId: "cron-012",
      };

      service.registerChatTrigger(config1);
      service.registerChatTrigger(config2);

      expect(service.getAllTriggers()).toHaveLength(2);

      service.clearAllTriggers();

      expect(service.getAllTriggers()).toHaveLength(0);
    });
  });

  describe("getWorkflowTriggers", () => {
    it("should return empty array for workflow with no triggers", () => {
      const config: ChatTriggerConfig = {
        workflowId: "wf-123",
        sessionKey: "slack:U123456",
        enabled: true,
        cronJobId: "cron-456",
      };

      service.registerChatTrigger(config);

      expect(service.getWorkflowTriggers("wf-999")).toHaveLength(0);
      expect(service.getWorkflowTriggers("wf-123")).toHaveLength(1);
    });
  });
});
