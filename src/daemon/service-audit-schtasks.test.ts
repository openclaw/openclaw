import { beforeEach, expect, it, vi } from "vitest";
import {
  exportedTaskDefaults,
  omitExportedTaskDefaults,
} from "./schtasks-export-defaults.test-support.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import { auditScheduledTaskDefinition } from "./service-audit-schtasks.js";
import type { ServiceDefinitionDrift } from "./service-audit-types.js";

const native = vi.hoisted(() => ({ task: vi.fn(), identity: vi.fn() }));
// mock-isolation: audit fixtures provide complete synthetic Task Scheduler XML responses.
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
// mock-isolation: SID lookup is isolated to deterministic synthetic identity results.
vi.mock("./exec-file.js", () => ({ execFileUtf8: native.identity }));

const env = { USERPROFILE: "C:\\Users\\fixture", USERNAME: "fixture" };
const expected = buildScheduledTaskXml({
  taskDescription: "OpenClaw Gateway",
  taskUser: "fixture",
  launchPath: resolveTaskScriptPath(env),
});
const presentExportedTaskDefaults = exportedTaskDefaults.filter(([key, value]) => {
  const tag = key.split(".").at(-1)!;
  const field = `<${tag}>${value}</${tag}>`;
  return expected.split(field).length === 2;
});
beforeEach(() => {
  native.task.mockReset();
  native.identity.mockReset().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
});

async function audit(installed: string, publication?: string) {
  native.task.mockResolvedValue({ code: 0, stdout: installed, stderr: "" });
  const findings: ServiceDefinitionDrift[] = [];
  await auditScheduledTaskDefinition(env, findings, undefined, undefined, publication);
  return findings;
}

it.each(["inspection", "publication", "expanded publication"])(
  "accepts equivalent Scheduler defaults during %s",
  async (mode) => {
    const omitted = omitExportedTaskDefaults(expected);
    expect(
      await audit(
        mode === "expanded publication" ? expected : omitted,
        mode === "inspection" ? undefined : mode === "publication" ? expected : omitted,
      ),
    ).toEqual([]);
  },
);

it.each(presentExportedTaskDefaults)(
  "does not treat non-default %s as an omission",
  async (key, value, changed) => {
    const tag = key.split(".").at(-1)!;
    const nonDefault = expected.replace(`<${tag}>${value}</${tag}>`, `<${tag}>${changed}</${tag}>`);
    expect(await audit(nonDefault, omitExportedTaskDefaults(expected))).toContainEqual(
      expect.objectContaining({ key, kind: "unknown-edit" }),
    );
    expect(await audit(omitExportedTaskDefaults(expected), nonDefault)).toContainEqual(
      expect.objectContaining({ key, kind: "outdated", current: null, expected: changed }),
    );
  },
);

it.each([
  ["Settings.Priority", "<Priority>7</Priority>", "<Priority>7</Priority><Priority>7</Priority>"],
  ["Settings.FuturePolicy", "</Settings>", "<FuturePolicy>false</FuturePolicy></Settings>"],
  ["Settings.Priority.@custom", "<Priority>7</Priority>", '<Priority custom="yes">7</Priority>'],
  ["Principals.Principal.UserId", "<UserId>fixture</UserId>", ""],
  ["Triggers.LogonTrigger.UserId", "<UserId>fixture</UserId>", "<UserId>foreign</UserId>"],
  ["Settings.ExecutionTimeLimit", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", ""],
] as const)("keeps refusing changed native field %s", async (key, from, to) => {
  // Missing principal identity must remove the second UserId, not the trigger's.
  const installed =
    key === "Principals.Principal.UserId"
      ? expected.replaceAll(from, to)
      : expected.replace(from, to);
  expect(await audit(installed, expected)).toContainEqual(expect.objectContaining({ key }));
});
