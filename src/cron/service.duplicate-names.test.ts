import { describe, expect, it } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

describe("cron duplicate name validation", () => {
  const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-duplicate-names-" });

  const createTestService = async () => {
    const { storePath } = await makeStorePath();
    const service = new CronService({
      cronEnabled: true,
      storePath,
      defaultAgentId: "test-agent",
      nowMs: () => Date.now(),
      log: logger,
      emit: () => {},
    });
    await service.start();
    return service;
  };

  const createJobInput = (name: string, overrides?: Partial<CronJobCreate>): CronJobCreate => ({
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test message" },
    ...overrides,
  });

  describe("cron.add", () => {
    it("allows adding a job with a unique name", async () => {
      const service = await createTestService();

      const job = await service.add(createJobInput("unique-job"));
      expect(job.name).toBe("unique-job");
    });

    it("rejects adding a job with a duplicate name", async () => {
      const service = await createTestService();

      await service.add(createJobInput("duplicate-job"));

      await expect(service.add(createJobInput("duplicate-job"))).rejects.toThrow(
        /a cron job named 'duplicate-job' already exists/,
      );
    });

    it("includes the existing job ID in the error message", async () => {
      const service = await createTestService();

      const existingJob = await service.add(createJobInput("existing-job"));

      await expect(service.add(createJobInput("existing-job"))).rejects.toThrow(
        new RegExp(`id=${existingJob.id}`),
      );
    });

    it("allows adding jobs with different names", async () => {
      const service = await createTestService();

      const job1 = await service.add(createJobInput("job-one"));
      const job2 = await service.add(createJobInput("job-two"));

      expect(job1.name).toBe("job-one");
      expect(job2.name).toBe("job-two");
      expect(job1.id).not.toBe(job2.id);
    });

    it("checks disabled jobs for name collisions", async () => {
      const service = await createTestService();

      await service.add(createJobInput("disabled-job", { enabled: false }));

      await expect(service.add(createJobInput("disabled-job"))).rejects.toThrow(
        /a cron job named 'disabled-job' already exists/,
      );
    });
  });

  describe("cron.update", () => {
    it("allows updating a job without changing its name", async () => {
      const service = await createTestService();

      const job = await service.add(createJobInput("update-test"));
      const updated = await service.update(job.id, { description: "updated description" });

      expect(updated.name).toBe("update-test");
      expect(updated.description).toBe("updated description");
    });

    it("allows renaming a job to a unique name", async () => {
      const service = await createTestService();

      const job = await service.add(createJobInput("old-name"));
      const updated = await service.update(job.id, { name: "new-name" });

      expect(updated.name).toBe("new-name");
    });

    it("rejects renaming a job to an existing name", async () => {
      const service = await createTestService();

      await service.add(createJobInput("existing-name"));
      const job2 = await service.add(createJobInput("job-to-rename"));

      await expect(service.update(job2.id, { name: "existing-name" })).rejects.toThrow(
        /a cron job named 'existing-name' already exists/,
      );
    });

    it("includes the conflicting job ID in the error message", async () => {
      const service = await createTestService();

      const existingJob = await service.add(createJobInput("taken-name"));
      const job2 = await service.add(createJobInput("rename-me"));

      await expect(service.update(job2.id, { name: "taken-name" })).rejects.toThrow(
        new RegExp(`id=${existingJob.id}`),
      );
    });

    it("allows renaming a job to its own name (no-op)", async () => {
      const service = await createTestService();

      const job = await service.add(createJobInput("same-name"));
      const updated = await service.update(job.id, { name: "same-name" });

      expect(updated.name).toBe("same-name");
    });

    it("checks disabled jobs for name collisions when renaming", async () => {
      const service = await createTestService();

      await service.add(createJobInput("disabled-target", { enabled: false }));
      const job2 = await service.add(createJobInput("active-job"));

      await expect(service.update(job2.id, { name: "disabled-target" })).rejects.toThrow(
        /a cron job named 'disabled-target' already exists/,
      );
    });
  });

  describe("edge cases", () => {
    it("handles case-sensitive name matching", async () => {
      const service = await createTestService();

      await service.add(createJobInput("MyJob"));
      const job2 = await service.add(createJobInput("myjob"));

      expect(job2.name).toBe("myjob");
    });

    it("handles names with special characters", async () => {
      const service = await createTestService();

      await service.add(createJobInput("job-with-dashes"));
      await expect(service.add(createJobInput("job-with-dashes"))).rejects.toThrow(
        /a cron job named 'job-with-dashes' already exists/,
      );
    });

    it("rejects empty string names", async () => {
      const service = await createTestService();

      await expect(service.add(createJobInput(""))).rejects.toThrow(/cron job name is required/);
    });
  });
});
