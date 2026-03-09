/**
 * Workflow Trigger Service
 *
 * Handles event-driven workflow triggers (e.g., Chat Message triggers)
 * Listens to internal hooks and executes matching workflows
 */

import {
  registerInternalHook,
  type InternalHookEvent,
  isMessageReceivedEvent,
} from "../hooks/internal-hooks.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * Chat trigger configuration
 */
export interface ChatTriggerConfig {
  workflowId: string;
  sessionKey: string;
  matchKeyword?: string;
  cronJobId: string;
  enabled: boolean;
}

/**
 * Workflow Trigger Service
 *
 * Singleton service that manages event-driven workflow triggers
 */
export class WorkflowTriggerService {
  private chatListeners = new Map<string, Set<ChatTriggerConfig>>();
  private logger = createSubsystemLogger("workflow-triggers");
  private initialized = false;

  /**
   * Initialize the trigger service - register internal hooks
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    // Register message:received hook listener
    registerInternalHook("message:received", async (event) => {
      await this.onMessageReceived(event);
    });

    this.initialized = true;
    this.logger.info("workflow trigger service initialized");
  }

  /**
   * Register a chat message trigger for a workflow
   */
  registerChatTrigger(config: ChatTriggerConfig): void {
    if (!config.enabled) {
      this.logger.debug(`skipping disabled trigger for workflow ${config.workflowId}`);
      return;
    }

    const { sessionKey } = config;

    if (!this.chatListeners.has(sessionKey)) {
      this.chatListeners.set(sessionKey, new Set());
      this.logger.info(`created new session listener for ${sessionKey}`);
    }

    this.chatListeners.get(sessionKey)!.add(config);
    this.logger.info(
      `registered chat trigger: workflow=${config.workflowId}, session=${sessionKey}, keyword=${config.matchKeyword || "none"}`,
    );
  }

  /**
   * Unregister a specific chat trigger
   */
  unregisterChatTrigger(config: ChatTriggerConfig): void {
    const { sessionKey } = config;
    const configs = this.chatListeners.get(sessionKey);

    if (!configs) {
      return;
    }

    const deleted = configs.delete(config);
    if (deleted) {
      this.logger.info(
        `unregistered chat trigger: workflow=${config.workflowId}, session=${sessionKey}`,
      );
    }

    // Clean up empty session listeners
    if (configs.size === 0) {
      this.chatListeners.delete(sessionKey);
      this.logger.debug(`removed empty session listener for ${sessionKey}`);
    }
  }

  /**
   * Unregister all triggers for a workflow
   */
  unregisterWorkflow(workflowId: string): void {
    let removedCount = 0;

    for (const [sessionKey, configs] of this.chatListeners.entries()) {
      const before = configs.size;
      const filtered = new Set([...configs].filter((c) => c.workflowId !== workflowId));

      if (filtered.size === 0) {
        this.chatListeners.delete(sessionKey);
      } else {
        this.chatListeners.set(sessionKey, filtered);
      }

      removedCount += before - filtered.size;
    }

    if (removedCount > 0) {
      this.logger.info(`unregistered ${removedCount} triggers for workflow ${workflowId}`);
    }
  }

  /**
   * Handle incoming message and trigger matching workflows
   */
  private async onMessageReceived(event: InternalHookEvent): Promise<void> {
    if (!isMessageReceivedEvent(event)) {
      return;
    }

    const { sessionKey, content, from, channelId, accountId, conversationId } = event.context;

    // Check if we have listeners for this session
    // Try matching against: exact sessionKey, channelId, or conversationId
    const possibleKeys = [
      String(sessionKey),
      channelId,
      conversationId,
      accountId ? `${channelId}:${accountId}` : undefined,
    ].filter(Boolean) as string[];

    let matchedConfigs: ChatTriggerConfig[] = [];

    for (const key of possibleKeys) {
      const configs = this.chatListeners.get(key);
      if (configs) {
        matchedConfigs = [...configs, ...matchedConfigs];
      }
    }

    if (matchedConfigs.length === 0) {
      return; // No workflows listening for this session
    }

    this.logger.info(
      `message received: session=${String(sessionKey)}, from=${String(from)}, matchedWorkflows=${matchedConfigs.length}`,
    );

    // Filter by keyword and execute matching workflows
    for (const config of matchedConfigs) {
      // Check keyword filter
      if (config.matchKeyword && !content.includes(config.matchKeyword)) {
        this.logger.debug(
          `chat trigger skipped: workflow=${config.workflowId}, keyword="${config.matchKeyword}" not matched`,
        );
        continue;
      }

      // Check if trigger is still enabled
      if (!config.enabled) {
        continue;
      }

      this.logger.info(
        `chat trigger matched: workflow=${config.workflowId}, session=${config.sessionKey}`,
      );

      // Trigger workflow execution by enqueueing system event
      // The cron system will pick this up and execute the workflow chain
      enqueueSystemEvent(content, {
        sessionKey: `workflow:${config.workflowId}`,
        contextKey: `trigger:${config.cronJobId}`,
      });

      this.logger.info(`workflow execution triggered: workflow=${config.workflowId}`);
    }
  }

  /**
   * Get all registered triggers (for debugging)
   */
  getAllTriggers(): Array<ChatTriggerConfig & { sessionKey: string }> {
    const result: Array<ChatTriggerConfig & { sessionKey: string }> = [];

    for (const [sessionKey, configs] of this.chatListeners.entries()) {
      for (const config of configs) {
        result.push({ ...config, sessionKey });
      }
    }

    return result;
  }

  /**
   * Get triggers for a specific workflow
   */
  getWorkflowTriggers(workflowId: string): Array<ChatTriggerConfig & { sessionKey: string }> {
    return this.getAllTriggers().filter((t) => t.workflowId === workflowId);
  }

  /**
   * Clear all triggers (for testing)
   */
  clearAllTriggers(): void {
    this.chatListeners.clear();
    this.logger.debug("all triggers cleared");
  }
}

// Singleton instance
export const workflowTriggerService = new WorkflowTriggerService();

// Auto-initialize on import
workflowTriggerService.initialize();
