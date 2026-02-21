import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimePolicy,
  getRuntimePolicy,
  registerRuntimePolicy,
} from "./runtime-policy-registry.js";
import type { RuntimePolicy } from "./runtime-policy.js";

describe("runtime-policy-registry", () => {
  beforeEach(() => {
    clearRuntimePolicy();
  });

  describe("registerRuntimePolicy", () => {
    it("should register a policy", () => {
      const policy: RuntimePolicy = {
        beforeToolInvoke: async () => {},
      };
      registerRuntimePolicy(policy);
      expect(getRuntimePolicy()).toBe(policy);
    });
  });

  describe("getRuntimePolicy", () => {
    it("should return undefined when no policy is registered", () => {
      expect(getRuntimePolicy()).toBeUndefined();
    });

    it("should return registered policy", () => {
      const policy: RuntimePolicy = {
        afterToolInvoke: async () => {},
      };
      registerRuntimePolicy(policy);
      expect(getRuntimePolicy()).toBe(policy);
    });
  });

  describe("clearRuntimePolicy", () => {
    it("should clear the registered policy", () => {
      const policy: RuntimePolicy = {
        beforeModelCall: async () => {},
      };
      registerRuntimePolicy(policy);
      clearRuntimePolicy();
      expect(getRuntimePolicy()).toBeUndefined();
    });
  });

  describe("tool hooks", () => {
    it("should execute beforeToolInvoke when policy is registered", async () => {
      const beforeFn = vi.fn();
      const policy: RuntimePolicy = {
        beforeToolInvoke: beforeFn,
      };
      registerRuntimePolicy(policy);

      await beforeFn({
        toolName: "test-tool",
        args: { foo: "bar" },
        sessionKey: "agent:main:default",
        source: "http",
      });

      expect(beforeFn).toHaveBeenCalledWith({
        toolName: "test-tool",
        args: { foo: "bar" },
        sessionKey: "agent:main:default",
        source: "http",
      });
    });

    it("should not execute beforeToolInvoke when policy is not registered", async () => {
      const beforeFn = vi.fn();
      clearRuntimePolicy();

      const policy = getRuntimePolicy();
      if (policy?.beforeToolInvoke) {
        await policy.beforeToolInvoke({
          toolName: "test-tool",
          args: {},
          source: "http",
        });
      }

      expect(beforeFn).not.toHaveBeenCalled();
    });

    it("should execute afterToolInvoke when policy is registered", async () => {
      const afterFn = vi.fn();
      const policy: RuntimePolicy = {
        afterToolInvoke: afterFn,
      };
      registerRuntimePolicy(policy);

      await afterFn({
        toolName: "test-tool",
        args: { foo: "bar" },
        result: { success: true },
        sessionKey: "agent:main:default",
        source: "gateway",
      });

      expect(afterFn).toHaveBeenCalledWith({
        toolName: "test-tool",
        args: { foo: "bar" },
        result: { success: true },
        sessionKey: "agent:main:default",
        source: "gateway",
      });
    });

    it("should not execute afterToolInvoke when policy is not registered", async () => {
      const afterFn = vi.fn();
      clearRuntimePolicy();

      const policy = getRuntimePolicy();
      if (policy?.afterToolInvoke) {
        await policy.afterToolInvoke({
          toolName: "test-tool",
          args: {},
          result: {},
          source: "agent",
        });
      }

      expect(afterFn).not.toHaveBeenCalled();
    });
  });

  describe("model hooks", () => {
    it("should execute beforeModelCall when policy is registered", async () => {
      const beforeFn = vi.fn();
      const policy: RuntimePolicy = {
        beforeModelCall: beforeFn,
      };
      registerRuntimePolicy(policy);

      await beforeFn({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        request: { messages: [] },
      });

      expect(beforeFn).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        request: { messages: [] },
      });
    });

    it("should not execute beforeModelCall when policy is not registered", async () => {
      const beforeFn = vi.fn();
      clearRuntimePolicy();

      const policy = getRuntimePolicy();
      if (policy?.beforeModelCall) {
        await policy.beforeModelCall({
          provider: "openai",
          model: "gpt-4o",
          request: {},
        });
      }

      expect(beforeFn).not.toHaveBeenCalled();
    });

    it("should execute afterModelCall when policy is registered", async () => {
      const afterFn = vi.fn();
      const policy: RuntimePolicy = {
        afterModelCall: afterFn,
      };
      registerRuntimePolicy(policy);

      await afterFn({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        response: { content: "Hello" },
      });

      expect(afterFn).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        response: { content: "Hello" },
      });
    });

    it("should not execute afterModelCall when policy is not registered", async () => {
      const afterFn = vi.fn();
      clearRuntimePolicy();

      const policy = getRuntimePolicy();
      if (policy?.afterModelCall) {
        await policy.afterModelCall({
          provider: "openai",
          model: "gpt-4o",
          response: {},
        });
      }

      expect(afterFn).not.toHaveBeenCalled();
    });
  });
});
