import { describe, expect, it } from "vitest";
import { createSystemHealthTool } from "./system-health-tool.js";

describe("system-health-tool", () => {
  const tool = createSystemHealthTool();

  describe("tool definition", () => {
    it("has correct metadata", () => {
      expect(tool.name).toBe("system_health");
      expect(tool.label).toBe("System Health");
      expect(tool.description).toContain("Monitor and diagnose system health");
    });

    it("has valid parameters schema", () => {
      expect(tool.parameters).toMatchObject({
        type: "object",
        properties: expect.objectContaining({
          action: expect.objectContaining({
            type: "string",
            enum: ["check", "diagnose", "monitor", "report", "analyze"],
          }),
          component: expect.objectContaining({
            type: "string",
            enum: ["all", "memory", "cpu", "disk", "network", "processes", "services", "logs", "performance"],
          }),
          duration: expect.objectContaining({
            type: "number",
            minimum: 30,
            maximum: 300,
          }),
          threshold: expect.objectContaining({
            type: "number",
            minimum: 0.1,
            maximum: 1.0,
          }),
          detailed: expect.objectContaining({
            type: "boolean",
          }),
        }),
        required: ["action"],
      });
    });
  });

  describe("execute function", () => {
    it("requires action parameter", async () => {
      await expect(
        tool.execute("test-id", {}, undefined, undefined),
      ).rejects.toThrow("Action is required");
    });

    it("performs health check action", async () => {
      const result = await tool.execute("test-id", { action: "check" }, undefined, undefined);

      
      expect(result).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
          }),
        ]),
        details: expect.objectContaining({
          overall: expect.stringMatching(/^(healthy|degraded|critical)$/),
          checks: expect.any(Array),
          summary: expect.objectContaining({
            total: expect.any(Number),
            healthy: expect.any(Number),
            warnings: expect.any(Number),
            critical: expect.any(Number),
          }),
          systemInfo: expect.objectContaining({
            platform: expect.any(String),
            arch: expect.any(String),
            nodeVersion: expect.any(String),
            uptime: expect.any(Number),
          }),
        }),
      });
    });

    it("performs diagnose action", async () => {
      const result = await tool.execute("test-id", { action: "diagnose" }, undefined, undefined);

      
      expect(result).toMatchObject({
        content: expect.any(Array),
        details: expect.objectContaining({
          diagnosis: expect.any(String),
          findings: expect.any(Array),
          actions: expect.any(Array),
        }),
      });
    });

    it("performs monitor action", async () => {
      const result = await tool.execute("test-id", { action: "monitor", duration: 30 }, undefined, undefined);

      
      expect(result).toMatchObject({
        content: expect.any(Array),
        details: expect.objectContaining({
          monitoring: expect.objectContaining({
            duration: 30,
            interval: 5000,
            samples: expect.any(Array),
          }),
          alerts: expect.any(Array),
        }),
      });
    });

    it("performs report action", async () => {
      const result = await tool.execute("test-id", { action: "report", detailed: true }, undefined, undefined);

      
      expect(result).toMatchObject({
        content: expect.any(Array),
        details: expect.objectContaining({
          report: expect.stringContaining("System Health Report"),
          metrics: expect.any(Object),
          recommendations: expect.any(Array),
        }),
      });
    });

    it("performs analyze action", async () => {
      const result = await tool.execute("test-id", { action: "analyze" }, undefined, undefined);

      
      expect(result).toMatchObject({
        content: expect.any(Array),
        details: expect.objectContaining({
          analysis: expect.stringContaining("System Performance Analysis"),
          trends: expect.any(Object),
          bottlenecks: expect.any(Array),
          optimizations: expect.any(Array),
        }),
      });
    });

    it("handles specific components", async () => {
      const result = await tool.execute("test-id", { action: "check", component: "memory" }, undefined, undefined);
      const details = result.details as any;
      
      expect(details.checks).toHaveLength(1);
      expect(details.checks[0].component).toBe("memory");
    });

    it("validates threshold parameter", async () => {
      const result = await tool.execute("test-id", { action: "check", threshold: 0.9 }, undefined, undefined);
      const details = result.details as any;
      
      expect(details).toBeDefined();
      expect(details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: expect.stringMatching(/^(healthy|warning|critical|unknown)$/),
          }),
        ]),
      );
    });

    it("includes recommendations when detailed is true", async () => {
      const result = await tool.execute("test-id", { action: "check", detailed: true }, undefined, undefined);
      const details = result.details as any;
      
      expect(details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recommendations: expect.any(Array),
          }),
        ]),
      );
    });

    it("rejects invalid action", async () => {
      await expect(
        tool.execute("test-id", { action: "invalid" }, undefined, undefined),
      ).rejects.toThrow("Unknown health action: invalid");
    });

    it("uses default values for optional parameters", async () => {
      const result = await tool.execute("test-id", { action: "check" }, undefined, undefined);
      const details = result.details as any;
      
      expect(details).toBeDefined();
      // Should use default component "all" and threshold 0.8
      expect(details.checks.length).toBeGreaterThan(1);
    });
  });

  describe("component health evaluation", () => {
    it("evaluates memory health correctly", async () => {
      const result = await tool.execute("test-id", { action: "check", component: "memory" }, undefined, undefined);
      const details = result.details as any;
      
      const memoryCheck = details.checks.find((c: any) => c.component === "memory");
      expect(memoryCheck).toBeDefined();
      expect(memoryCheck.metrics).toHaveProperty("heapUsed");
      expect(memoryCheck.metrics).toHaveProperty("heapTotal");
      expect(memoryCheck.metrics).toHaveProperty("heapUsageRatio");
      expect(memoryCheck.status).toMatch(/^(healthy|warning|critical|unknown)$/);
    });

    it("evaluates CPU health correctly", async () => {
      const result = await tool.execute("test-id", { action: "check", component: "cpu" }, undefined, undefined);
      const details = result.details as any;
      
      const cpuCheck = details.checks.find((c: any) => c.component === "cpu");
      expect(cpuCheck).toBeDefined();
      expect(cpuCheck.metrics).toHaveProperty("usagePercent");
      expect(cpuCheck.status).toMatch(/^(healthy|warning|critical|unknown)$/);
    });

    it("evaluates disk health correctly", async () => {
      const result = await tool.execute("test-id", { action: "check", component: "disk" }, undefined, undefined);
      const details = result.details as any;
      
      const diskCheck = details.checks.find((c: any) => c.component === "disk");
      expect(diskCheck).toBeDefined();
      expect(diskCheck.metrics).toHaveProperty("total");
      expect(diskCheck.metrics).toHaveProperty("used");
      expect(diskCheck.metrics).toHaveProperty("usagePercent");
      expect(diskCheck.status).toMatch(/^(healthy|warning|critical|unknown)$/);
    });

    it("evaluates services health correctly", async () => {
      const result = await tool.execute("test-id", { action: "check", component: "services" }, undefined, undefined);
      const details = result.details as any;
      
      const servicesCheck = details.checks.find((c: any) => c.component === "services");
      expect(servicesCheck).toBeDefined();
      expect(servicesCheck.metrics).toHaveProperty("gateway");
      expect(servicesCheck.metrics).toHaveProperty("database");
      expect(servicesCheck.metrics).toHaveProperty("cache");
      expect(servicesCheck.status).toMatch(/^(healthy|warning|critical|unknown)$/);
    });
  });

  describe("monitoring functionality", () => {
    it("collects samples over duration", async () => {
      const result = await tool.execute("test-id", { action: "monitor", duration: 60 }, undefined, undefined);
      const details = result.details as any;
      
      expect(details.monitoring.samples).toBeInstanceOf(Array);
      expect(details.monitoring.duration).toBe(60);
      expect(details.monitoring.interval).toBe(5000);
      
      // Each sample should have timestamp, metrics, and status
      details.monitoring.samples.forEach((sample: any) => {
        expect(sample).toHaveProperty("timestamp");
        expect(sample).toHaveProperty("metrics");
        expect(sample).toHaveProperty("status");
      });
    });

    it("generates alerts for unhealthy states", async () => {
      const result = await tool.execute("test-id", { action: "monitor", component: "memory", threshold: 0.1 }, undefined, undefined);
      const details = result.details as any;
      
      // With very low threshold, should generate alerts
      expect(details.alerts).toBeInstanceOf(Array);
      if (details.alerts.length > 0) {
        details.alerts.forEach((alert: any) => {
          expect(alert).toHaveProperty("timestamp");
          expect(alert).toHaveProperty("component");
          expect(alert).toHaveProperty("status");
          expect(alert).toHaveProperty("metrics");
          expect(alert.status).toMatch(/^(warning|critical)$/);
        });
      }
    });
  });

  describe("report generation", () => {
    it("generates comprehensive health report", async () => {
      const result = await tool.execute("test-id", { action: "report", detailed: true }, undefined, undefined);
      const details = result.details as any;
      
      expect(details.report).toContain("System Health Report");
      expect(details.report).toContain("Overall Status:");
      expect(details.report).toContain("System Information:");
      expect(details.report).toContain("Component Details:");
      
      expect(details.metrics).toHaveProperty("cpu");
      expect(details.metrics).toHaveProperty("memory");
      expect(details.metrics).toHaveProperty("disk");
      expect(details.metrics).toHaveProperty("processes");
      
      expect(details.recommendations).toBeInstanceOf(Array);
    });
  });

  describe("performance analysis", () => {
    it("analyzes system performance and provides insights", async () => {
      const result = await tool.execute("test-id", { action: "analyze", detailed: true }, undefined, undefined);
      const details = result.details as any;
      
      expect(details.analysis).toContain("System Performance Analysis");
      expect(details.analysis).toContain("Current Performance Metrics:");
      expect(details.analysis).toContain("Identified Bottlenecks:");
      expect(details.analysis).toContain("Performance Trends:");
      
      expect(details.trends).toBeInstanceOf(Object);
      expect(details.bottlenecks).toBeInstanceOf(Array);
      expect(details.optimizations).toBeInstanceOf(Array);
      
      // Should have specific optimization suggestions
      expect(details.optimizations.length).toBeGreaterThan(0);
    });
  });
});
