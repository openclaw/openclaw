import { describe, expect, it } from "vitest";
import type { HealthFinding } from "../flows/health-checks.js";
import { renderTriagePrompt, type TriageBundle } from "./triage-prompt.js";

function contains(prompt: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(prompt).toContain(fragment);
  }
}

function excludes(prompt: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(prompt).not.toContain(fragment);
  }
}
const includesObject = (shape: unknown) => expect.arrayContaining([expect.objectContaining(shape)]);

describe("renderTriagePrompt", () => {
  const homeDir = "/home/triage-test";
  const redaction = {
    env: { HOME: homeDir },
    stateDir: `${homeDir}/.openclaw`,
  };
  const render = (params: Partial<Parameters<typeof renderTriagePrompt>[0]>) =>
    renderTriagePrompt({ findings: [], bundle: { kind: "skipped" }, redaction, ...params });

  it("redacts home and state paths across finding fields and diagnostics handoffs", () => {
    const prompt = render({
      findings: [
        {
          checkId: `${homeDir}/checks/config`,
          severity: "error",
          message: `Config: ${redaction.stateDir}/openclaw.json\nneeds repair`,
          fixHint: `Inspect ${homeDir}/logs/gateway.log`,
        },
      ],
      bundle: { kind: "available", path: `${homeDir}/Downloads/diagnostics.zip` },
    });
    contains(
      prompt,
      "[error] ~/checks/config: Config: $OPENCLAW_STATE_DIR/openclaw.json needs repair",
      "Fix: Inspect ~/logs/gateway.log",
      "Sanitized ZIP: ~/Downloads/diagnostics.zip",
    );
    expect(prompt).not.toContain(homeDir);
  });

  it("hard-bounds multibyte findings and explicitly reports omitted findings", () => {
    const findings: HealthFinding[] = Array.from({ length: 25 }, (_, index) => ({
      checkId: `core/check-${index}`,
      severity: "warning",
      message: "🦞".repeat(4_000),
      fixHint: "修".repeat(4_000),
    }));

    const prompt = render({
      findings,
      updateFailure: { error: "Original update failure: " + "🦞".repeat(4_000) },
    });

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8 * 1024);
    const rendered = prompt.match(/^- \[warning\]/gmu)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(prompt).toContain(
      `${findings.length - rendered} more findings omitted; run \`openclaw doctor\` for the full list.`,
    );
    contains(prompt, "Original update failure:", "## Privacy", "...");
    excludes(prompt, "\uFFFD");
  });

  it("preserves deliberate stopped state in the repair goal", () => {
    const prompt = render({
      failure: { kind: "update", phase: "build", error: "build failed", gateway: "preserve" },
    });
    contains(prompt, "Do not start or restart the Gateway", "remaining blocker");
  });

  it.each<TriageBundle>([
    { kind: "available", path: `${homeDir}/${"修".repeat(2_000)}/diagnostics.zip` },
    { kind: "unavailable", reason: `Export failed: ${"🦞".repeat(2_000)}` },
  ])("fits complete failure evidence and handoff details: $kind", (bundle) => {
    const noisy = '\\"'.repeat(1_000);
    const prompt = render({
      bundle,
      failure: {
        kind: "gateway-startup",
        phase: "startup",
        error: `Current startup failure: token=sk-test-triage-secret-1234567890 ${"🦞".repeat(4_000)}`,
        installationRoot: `${homeDir}/installation/${"修".repeat(2_000)}`,
        expectedVersion: "2026.8.31",
        gateway: "verify-running",
      },
      updateFailure: {
        error: `Original update failure ${noisy}`,
        result: {
          status: "error",
          mode: "npm",
          reason: `runtime-check-failed ${noisy}`,
          root: `${homeDir}/${noisy}`,
          before: { sha: noisy, version: noisy },
          after: { sha: noisy, version: noisy },
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: Array.from({ length: 6 }, (_, index) => ({
            name: `step-${index} ${noisy}`,
            exitCode: 1,
            stdoutTail: `${noisy} actual-compiler-cause-${index}`,
            stderrTail: `${noisy} npm failure footer`,
          })),
          postUpdate: {
            plugins: {
              status: "error",
              reason: `plugin-finalization-failed ${noisy}`,
              warnings: Array.from({ length: 5 }, (_, index) => ({
                pluginId: noisy,
                reason: `Doctor cause-${index} ${noisy}`,
                message: noisy,
              })),
            },
          },
        },
      },
    });
    const details = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "";
    const recorded = JSON.parse(details) as { omittedDetails: number };

    expect(recorded).toMatchObject({
      error: expect.stringContaining("Original update failure"),
      result: {
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: includesObject({ stdoutTail: expect.stringContaining("actual-compiler-cause-5") }),
        postUpdate: {
          plugins: {
            warnings: includesObject({ reason: expect.stringContaining("Doctor cause-4") }),
          },
        },
      },
    });
    expect(recorded.omittedDetails).toBeGreaterThan(0);
    expect(Buffer.byteLength(details)).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
    expect(prompt.indexOf("## Triggering failure")).toBeLessThan(
      prompt.indexOf("## Failed update"),
    );
    expect(prompt.indexOf("## Failed update")).toBeLessThan(prompt.indexOf("## Doctor findings"));
    contains(prompt, "No advisory doctor findings were reported.");
    contains(prompt, "- Kind: gateway-startup", "- Phase: startup", "Current startup failure:");
    contains(prompt, "- Installation: ~/installation/", "- Expected version: 2026.8.31");
    contains(prompt, "## Diagnostics bundle", "## Privacy");
    contains(prompt, "local paths are relative to `~` or `$OPENCLAW_STATE_DIR`.");
    excludes(prompt, "sk-test-triage-secret-1234567890", "Prompt truncated", "\uFFFD");
  });
});
