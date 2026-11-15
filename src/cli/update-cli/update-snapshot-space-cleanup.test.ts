import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { writeSucceededUpdateCopies } from "./update-recovery-copies.test-support.js";
import { assessSnapshotCapacityOfferingCleanup } from "./update-snapshot-space-cleanup.js";

const answer = vi.hoisted(() => ({ value: true as boolean, asked: [] as string[] }));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async ({ message }: { message: string }) => {
    answer.asked.push(message);
    return answer.value;
  },
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let superseded: string;
let latest: string;

beforeEach(() => {
  const home = fs.realpathSync(dirs.make("update-space-cleanup-"));
  const stateDir = path.join(home, "state");
  fs.mkdirSync(stateDir);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
  // The later success supersedes the earlier capture; its own copy stays protected.
  [superseded, latest] = writeSucceededUpdateCopies(stateDir, [
    Date.UTC(2026, 9, 1),
    Date.UTC(2026, 9, 2),
  ]) as [string, string];
  closeOpenClawStateDatabaseForTest();
  answer.value = true;
  answer.asked = [];
});

afterEach(async () => {
  for (const [index, stream] of streams.entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const streams = [process.stdin, process.stderr] as const;
const ttyDescriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function terminal(interactive: boolean) {
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { value: interactive, configurable: true });
  }
}

/** Space is short until the superseded copy is gone, as on a full disk. */
function spaceCheck() {
  const step = (exitCode: number): UpdateStepResult => ({
    name: "snapshot-space-preflight",
    command: "snapshot-space-preflight",
    cwd: "",
    durationMs: 0,
    exitCode,
    ...(exitCode ? { stderrTail: "snapshot-capacity-insufficient: no space" } : {}),
  });
  return vi.fn(async () => step(fs.existsSync(superseded) ? 1 : 0));
}

it("removes retirable copies after an interactive yes and checks space again", async () => {
  terminal(true);
  const assess = spaceCheck();
  const printed: string[] = [];

  const result = await assessSnapshotCapacityOfferingCleanup(assess, {
    print: (line) => printed.push(line),
  });

  expect(answer.asked).toEqual([expect.stringContaining("Permanently remove")]);
  expect(printed[0]).toMatch(/^1 recovery copy from earlier updates use .+ and can be removed\.$/u);
  expect(printed).toContainEqual(expect.stringContaining(superseded));
  expect(printed).not.toContainEqual(expect.stringContaining(latest));
  expect([superseded, latest].map(fs.existsSync)).toEqual([false, true]);
  expect(assess).toHaveBeenCalledTimes(2);
  expect(result.exitCode).toBe(0);
});

it("keeps every copy and the refusal when the user declines", async () => {
  terminal(true);
  answer.value = false;
  const assess = spaceCheck();

  const result = await assessSnapshotCapacityOfferingCleanup(assess, { print: () => {} });

  expect(answer.asked).toHaveLength(1);
  expect([superseded, latest].map(fs.existsSync)).toEqual([true, true]);
  expect(assess).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    exitCode: 1,
    stderrTail: "snapshot-capacity-insufficient: no space",
  });
});

it.each([
  { case: "--yes", options: { yes: true }, interactive: true },
  { case: "--json", options: { json: true }, interactive: true },
  { case: "no terminal", options: {}, interactive: false },
  { case: "a mid-update check", options: { prompt: false }, interactive: true },
])("only reports retirable copies for $case", async ({ options, interactive }) => {
  terminal(interactive);
  const assess = spaceCheck();

  const result = await assessSnapshotCapacityOfferingCleanup(assess, {
    ...options,
    print: () => {},
  });

  expect(answer.asked).toEqual([]);
  expect([superseded, latest].map(fs.existsSync)).toEqual([true, true]);
  expect(result.exitCode).toBe(1);
  expect(result.stderrTail).toMatch(
    /^snapshot-capacity-insufficient: no space\n1 recovery copy from earlier updates use .+ and can be removed\. Run openclaw update in a terminal/u,
  );
});

it("leaves a refusal unchanged when nothing is retirable", async () => {
  terminal(true);
  fs.rmSync(superseded, { recursive: true });
  const assess = vi.fn(async () => ({ ...(await spaceCheck()()), exitCode: 1 }));

  const result = await assessSnapshotCapacityOfferingCleanup(assess, { print: () => {} });

  expect(answer.asked).toEqual([]);
  expect(fs.existsSync(latest)).toBe(true);
  expect(result.exitCode).toBe(1);
});
