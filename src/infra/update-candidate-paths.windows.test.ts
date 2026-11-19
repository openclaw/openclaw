import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { isPathInside } from "./path-guards.js";
import {
  resolveUpdateCandidateAvatar,
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";

// Exercise Windows projection on every host; native worker coverage lives in
// update-candidate-state.namespaced-paths.test.ts.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => mockProcessPlatform("win32"));
afterEach(() => vi.restoreAllMocks());

const STATE_ROOT = String.raw`C:\Users\me\.openclaw`;
const CANARY_ROOT = String.raw`C:\Users\me\.openclaw\.update-canary\openclaw-update-canary-abc123`;
const AGENT_RELATIVE = String.raw`agents\main\agent\openclaw-agent.sqlite`;

function namespaced(value: string): string {
  return `\\\\?\\${value}`;
}

const plain = path.join(STATE_ROOT, AGENT_RELATIVE);
const external = namespaced(String.raw`D:\External\openclaw-agent.sqlite`);
const noncanonical = `${STATE_ROOT}\\agents\\main\\.\\agent\\openclaw-agent.sqlite`;

it.each([
  [STATE_ROOT, plain, plain, true],
  [STATE_ROOT, namespaced(plain), plain, true],
  [namespaced(STATE_ROOT), namespaced(plain), plain, true],
  [STATE_ROOT, external, external, false],
  [STATE_ROOT, noncanonical, noncanonical, false],
] as const)("projects Windows root %s and locator %s safely", (root, source, identity, rebased) => {
  expect(resolveUpdateCandidateStateIdentity(root, source)).toBe(identity);
  const projected = resolveUpdateCandidateStatePath(root, CANARY_ROOT, source);
  const relative = path.relative(CANARY_ROOT, projected);
  if (rebased) {
    expect(projected).toBe(path.join(CANARY_ROOT, AGENT_RELATIVE));
    expect(relative).toBe(AGENT_RELATIVE);
  } else {
    expect(relative.startsWith("candidate-external")).toBe(true);
  }
  expect(projected).not.toContain("?");
  expect(isPathInside(CANARY_ROOT, projected)).toBe(true);
});

// The process sits on D: so a drive-less root must take the workspace drive.
it.each([
  [String.raw`C:\Users\me\clawd`, String.raw`\Users\me\clawd\a.png`, String.raw`.\a.png`],
  [String.raw`\\?\C:\Users\me\clawd`, String.raw`C:\Users\me\clawd\a.png`, String.raw`.\a.png`],
  [String.raw`C:\Users\me\clawd`, String.raw`..\clawd\a.png`, String.raw`.\a.png`],
  [
    String.raw`C:\Users\me\clawd`,
    String.raw`\Users\me\main\a.png`,
    String.raw`C:\Users\me\main\a.png`,
  ],
] as const)("projects Windows workspace %s avatar %s as %s", (workspace, avatar, expected) => {
  vi.spyOn(process, "cwd").mockReturnValue(String.raw`D:\work`);
  expect(resolveUpdateCandidateAvatar(workspace, avatar)).toBe(expected);
});
