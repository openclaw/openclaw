import { describe, expect, it, vi } from "vitest";

describe("plugin-sdk qa-runner-shared-runtime", () => {
  it("renders shared QA markdown reports with multiline details", async () => {
    const module = await import("./qa-runner-shared-runtime.js");

    const report = module.renderQaMarkdownReport({
      title: "QA Report",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:02.000Z"),
      checks: [{ name: "preflight", status: "pass" }],
      scenarios: [
        {
          name: "transport reply",
          status: "fail",
          details: "line one\nline two",
          steps: [{ name: "send", status: "pass", details: "ok" }],
        },
      ],
      timeline: ["sent request"],
      notes: ["kept artifacts"],
    });

    expect(report).toContain("# QA Report");
    expect(report).toContain("- Duration ms: 2000");
    expect(report).toContain("- Passed: 1");
    expect(report).toContain("- Failed: 1");
    expect(report).toContain("```text\nline one\nline two\n```");
    expect(report).toContain("- [x] send");
    expect(report).toContain("## Timeline");
  });

  it("builds shared live-lane artifact errors", async () => {
    const module = await import("./qa-runner-shared-runtime.js");

    expect(
      module.buildQaLiveLaneArtifactsError({
        heading: "Matrix QA failed.",
        details: ["cleanup: ok"],
        artifacts: {
          report: "/tmp/report.md",
          summary: "/tmp/summary.json",
        },
      }),
    ).toBe(
      [
        "Matrix QA failed.",
        "cleanup: ok",
        "Artifacts:",
        "- report: /tmp/report.md",
        "- summary: /tmp/summary.json",
      ].join("\n"),
    );
  });

  it("shares Docker health parsing across array and jsonl compose output", async () => {
    const module = await import("./qa-runner-shared-runtime.js");
    const runtime = module.createQaDockerRuntime({ auditContext: "qa-test" });
    const dockerPsOutputs = ['[{"Health":"starting"}]', '{"State":"running"}\n'];
    const runCommand = vi.fn(async () => ({
      stdout: dockerPsOutputs.shift() ?? '{"State":"running"}',
      stderr: "",
    }));
    const sleepImpl = vi.fn(async () => {});

    await runtime.waitForDockerServiceHealth(
      "homeserver",
      "/tmp/docker-compose.yml",
      "/repo",
      runCommand,
      sleepImpl,
    );

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });
});
