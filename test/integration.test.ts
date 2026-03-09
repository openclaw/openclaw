/**
 * Chain Memory Backend - 集成测试
 *
 * 验证核心功能的基本集成测试
 *
 * @module integration.test
 * @author Tutu
 * @date 2026-03-09
 */

import { validateChainConfig } from "../src/config-validator";
import { AsyncWriteQueue } from "../src/memory/chain/async-queue";
import { CircuitBreaker } from "../src/memory/chain/circuit-breaker";
import type { AsyncWriteTask } from "../src/memory/chain/types";

describe("Integration Tests", () => {
  describe("Circuit Breaker", () => {
    it("should start in CLOSED state", () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe("CLOSED");
      expect(cb.isOpen()).toBe(false);
    });

    it("should open after threshold failures", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      // 记录 3 次失败
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe("OPEN");
      expect(cb.isOpen()).toBe(true);
    });

    it("should reset to CLOSED after timeout", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });

      // 触发熔断
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe("OPEN");

      // 等待超时
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 应该进入 HALF-OPEN
      expect(cb.isOpen()).toBe(false);
      expect(cb.getState()).toBe("HALF-OPEN");

      // 记录成功，应该回到 CLOSED
      cb.recordSuccess();
      expect(cb.getState()).toBe("CLOSED");
    });

    it("should reset on success", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

      // 记录一些失败
      cb.recordFailure();
      cb.recordFailure();

      // 记录成功
      cb.recordSuccess();

      expect(cb.getState()).toBe("CLOSED");
      expect(cb.getFailureCount()).toBe(0);
    });
  });

  describe("Async Write Queue", () => {
    it("should enqueue and process tasks", async () => {
      const queue = new AsyncWriteQueue({ maxConcurrent: 2 });
      const processed: string[] = [];

      queue.setProcessor(async (task) => {
        processed.push(task.id);
      });

      // 添加任务
      const taskId1 = queue.enqueue("provider1", "add", { data: "test1" });
      const taskId2 = queue.enqueue("provider1", "add", { data: "test2" });

      // 等待处理
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(processed).toHaveLength(2);
      expect(processed).toContain(taskId1);
      expect(processed).toContain(taskId2);
    });

    it("should retry failed tasks", async () => {
      const queue = new AsyncWriteQueue({
        maxConcurrent: 1,
        retryDelayMs: 50,
        maxRetries: 2,
      });
      let attempts = 0;

      queue.setProcessor(async (_task) => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Simulated failure");
        }
      });

      queue.enqueue("provider1", "add", { data: "test" });

      // 等待重试
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(attempts).toBe(2);
    });

    it("should move to dead letter after max retries", async () => {
      const queue = new AsyncWriteQueue({
        maxConcurrent: 1,
        retryDelayMs: 10,
        maxRetries: 2,
      });

      queue.setProcessor(async () => {
        throw new Error("Always fails");
      });

      queue.enqueue("provider1", "add", { data: "test" });

      // 等待所有重试
      await new Promise((resolve) => setTimeout(resolve, 100));

      const deadLetter = queue.getDeadLetterQueue();
      expect(deadLetter).toHaveLength(1);
      expect(deadLetter[0].error).toContain("Always fails");
    });

    it("should report queue status", () => {
      const queue = new AsyncWriteQueue();

      queue.enqueue("provider1", "add", { data: "test" });

      const status = queue.getStatus();
      expect(status.pending).toBeGreaterThanOrEqual(0);
      expect(status.processing).toBeGreaterThanOrEqual(0);
      expect(status.deadLetter).toBe(0);
    });
  });

  describe("Config Validation", () => {
    it("should validate and apply defaults", () => {
      const config = {
        providers: [{ name: "test", priority: "primary" as const, backend: "builtin" as const }],
      };

      const result = validateChainConfig(config);

      expect(result.global.defaultTimeout).toBe(5000);
      expect(result.global.enableAsyncWrite).toBe(true);
      expect(result.global.enableFallback).toBe(true);
      expect(result.global.healthCheckInterval).toBe(30000);

      expect(result.providers[0].enabled).toBe(true);
      expect(result.providers[0].writeMode).toBe("sync");
    });

    it("should reject invalid config", () => {
      const config = {
        providers: [
          {
            name: "test",
            priority: "invalid" as unknown as "primary",
            backend: "builtin" as const,
          },
        ],
      };

      expect(() => validateChainConfig(config)).toThrow();
    });
  });

  describe("End-to-End Flow", () => {
    it("should handle complete flow", async () => {
      // 1. 验证配置
      const config = {
        providers: [
          {
            name: "primary",
            priority: "primary" as const,
            backend: "builtin" as const,
            circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000 },
          },
          {
            name: "backup",
            priority: "secondary" as const,
            backend: "builtin" as const,
            writeMode: "async" as const,
          },
        ],
      };

      const validated = validateChainConfig(config);
      expect(validated.providers).toHaveLength(2);

      // 2. 创建熔断器
      const cb = new CircuitBreaker(validated.providers[0].circuitBreaker);
      expect(cb.getState()).toBe("CLOSED");

      // 3. 创建异步队列
      const queue = new AsyncWriteQueue();
      const processed: AsyncWriteTask[] = [];

      queue.setProcessor(async (task) => {
        processed.push(task);
      });

      // 4. 添加异步任务
      queue.enqueue("backup", "add", { content: "test memory" });

      // 5. 等待处理
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(processed).toHaveLength(1);
      expect(processed[0].data.content).toBe("test memory");

      // 6. 模拟失败和熔断
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.isOpen()).toBe(true);

      // 7. 等待恢复
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(cb.isOpen()).toBe(false);
      expect(cb.getState()).toBe("HALF-OPEN");
    });
  });
});
