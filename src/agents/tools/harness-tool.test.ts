import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHarnessTools } from "./harness-tool.js";

// Must use globalThis to intercept fetch used by harness-tool's hubFetch
const fetchMock = vi.fn();

function mockHubResponse(data: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
}

describe("harness-tool", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("exports two tools", () => {
    const tools = createHarnessTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("harness_report_step");
    expect(tools[1].name).toBe("harness_report_check");
  });

  describe("harness_report_step", () => {
    it("calls verify API with step type", async () => {
      const tools = createHarnessTools();
      const reportStep = tools[0];

      mockHubResponse({
        verification: { status: "in_progress" },
        summary: { stepsTotal: 5, stepsDone: 1, stepsRemaining: 4 },
      });

      const result = await reportStep.execute("call_1", {
        item_id: "item_123",
        step_index: 0,
        status: "done",
        note: "Completed first step",
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain("/api/harness/item_123/verify");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.type).toBe("step");
      expect(body.index).toBe(0);
      expect(body.status).toBe("done");
      expect(body.note).toBe("Completed first step");

      const details = result.details as Record<string, unknown>;
      expect(details.success).toBe(true);
      expect(details.stepIndex).toBe(0);
      expect(details.stepsRemaining).toBe(4);
      expect(details.verificationStatus).toBe("in_progress");
    });

    it("returns error when API returns error", async () => {
      const tools = createHarnessTools();
      const reportStep = tools[0];

      mockHubResponse({ error: "Item not found" });

      const result = await reportStep.execute("call_2", {
        item_id: "nonexistent",
        step_index: 0,
        status: "done",
      });

      const details = result.details as Record<string, unknown>;
      expect(details.success).toBe(false);
      expect(details.error).toBe("Item not found");
    });

    it("sends skipped status correctly", async () => {
      const tools = createHarnessTools();
      const reportStep = tools[0];

      mockHubResponse({
        verification: { status: "in_progress" },
        summary: { stepsTotal: 3, stepsDone: 2, stepsRemaining: 1 },
      });

      await reportStep.execute("call_3", {
        item_id: "item_123",
        step_index: 1,
        status: "skipped",
        note: "Not applicable",
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.status).toBe("skipped");
      expect(body.note).toBe("Not applicable");
    });
  });

  describe("harness_report_check", () => {
    it("calls verify API with check type and passed=true", async () => {
      const tools = createHarnessTools();
      const reportCheck = tools[1];

      mockHubResponse({
        verification: { status: "in_progress" },
        summary: { checksTotal: 3, checksPassed: 1, checksRemaining: 2 },
      });

      const result = await reportCheck.execute("call_4", {
        item_id: "item_456",
        check_index: 0,
        passed: true,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain("/api/harness/item_456/verify");

      const body = JSON.parse(options.body);
      expect(body.type).toBe("check");
      expect(body.index).toBe(0);
      expect(body.status).toBe(true);

      const details = result.details as Record<string, unknown>;
      expect(details.success).toBe(true);
      expect(details.passed).toBe(true);
      expect(details.checksRemaining).toBe(2);
      expect(details.allChecksPassed).toBe(false);
    });

    it("detects all checks passed", async () => {
      const tools = createHarnessTools();
      const reportCheck = tools[1];

      mockHubResponse({
        verification: { status: "passed" },
        summary: { checksTotal: 3, checksPassed: 3, checksRemaining: 0 },
      });

      const result = await reportCheck.execute("call_5", {
        item_id: "item_456",
        check_index: 2,
        passed: true,
      });

      const details = result.details as Record<string, unknown>;
      expect(details.allChecksPassed).toBe(true);
      expect(details.verificationStatus).toBe("passed");
    });

    it("handles failed check", async () => {
      const tools = createHarnessTools();
      const reportCheck = tools[1];

      mockHubResponse({
        verification: { status: "in_progress" },
        summary: { checksTotal: 3, checksPassed: 0, checksRemaining: 3 },
      });

      const result = await reportCheck.execute("call_6", {
        item_id: "item_456",
        check_index: 0,
        passed: false,
        note: "Build fails",
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.status).toBe(false);
      expect(body.note).toBe("Build fails");

      const details = result.details as Record<string, unknown>;
      expect(details.passed).toBe(false);
      expect(details.allChecksPassed).toBe(false);
    });

    it("returns error when API returns error", async () => {
      const tools = createHarnessTools();
      const reportCheck = tools[1];

      mockHubResponse({ error: "check index 5 out of range (max: 2)" });

      const result = await reportCheck.execute("call_7", {
        item_id: "item_456",
        check_index: 5,
        passed: true,
      });

      const details = result.details as Record<string, unknown>;
      expect(details.success).toBe(false);
      expect(details.error).toContain("out of range");
    });
  });
});
