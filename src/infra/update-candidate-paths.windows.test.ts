import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { isPathInside } from "./path-guards.js";
import {
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";

// Extended-length Windows locators must project under the candidate root
// without embedding a namespace prefix mid-path. These path-semantics cases
// complement the native Windows snapshot-worker coverage in
// update-candidate-state.namespaced-paths.test.ts, which skips on other platforms.
// Related issue #150386 does not establish this defect as its underlying cause.
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

// The snapshot mkdir creates every projected directory recursively, so a
// namespace prefix embedded mid-path must never appear.
function expectSafeProjection(projected: string): void {
  expect(projected).not.toContain("?");
  expect(isPathInside(CANARY_ROOT, projected)).toBe(true);
}

describe("Windows extended-length candidate state projection", () => {
  it("rebases a plain in-root locator under the candidate root", () => {
    const source = path.join(STATE_ROOT, AGENT_RELATIVE);
    const projected = resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, source);
    expect(projected).toBe(path.join(CANARY_ROOT, AGENT_RELATIVE));
    expect(path.relative(CANARY_ROOT, projected)).toBe(AGENT_RELATIVE);
    expectSafeProjection(projected);
  });

  it("rebases an extended-length in-root locator without embedding the namespace prefix", () => {
    const plain = path.join(STATE_ROOT, AGENT_RELATIVE);
    const projected = resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, namespaced(plain));
    expect(projected).toBe(path.join(CANARY_ROOT, AGENT_RELATIVE));
    expect(path.relative(CANARY_ROOT, projected)).toBe(AGENT_RELATIVE);
    expectSafeProjection(projected);
  });

  it("gives plain and extended-length spellings one projection identity", () => {
    const plain = path.join(STATE_ROOT, AGENT_RELATIVE);
    expect(resolveUpdateCandidateStateIdentity(STATE_ROOT, namespaced(plain))).toBe(plain);
    expect(resolveUpdateCandidateStateIdentity(STATE_ROOT, plain)).toBe(plain);
    expect(resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, namespaced(plain))).toBe(
      resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, plain),
    );
  });

  it("keeps an extended-length external locator on one hashed projection identity", () => {
    const external = String.raw`D:\External\openclaw-agent.sqlite`;
    const source = namespaced(external);
    const projected = resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, source);
    expect(path.relative(CANARY_ROOT, projected).startsWith("candidate-external")).toBe(true);
    expect(resolveUpdateCandidateStateIdentity(STATE_ROOT, source)).toBe(source);
    expectSafeProjection(projected);
  });

  it("hashes a noncanonical in-root locator instead of collapsing its dot segments", () => {
    const noncanonical = `${STATE_ROOT}\\agents\\main\\.\\agent\\openclaw-agent.sqlite`;
    const projected = resolveUpdateCandidateStatePath(STATE_ROOT, CANARY_ROOT, noncanonical);
    expect(path.relative(CANARY_ROOT, projected).startsWith("candidate-external")).toBe(true);
    expect(resolveUpdateCandidateStateIdentity(STATE_ROOT, noncanonical)).toBe(noncanonical);
    expectSafeProjection(projected);
  });

  it("rebases an extended-length locator under a namespaced state root", () => {
    const source = namespaced(path.join(STATE_ROOT, AGENT_RELATIVE));
    const projected = resolveUpdateCandidateStatePath(namespaced(STATE_ROOT), CANARY_ROOT, source);
    expect(projected).toBe(path.join(CANARY_ROOT, AGENT_RELATIVE));
    expect(path.relative(CANARY_ROOT, projected)).toBe(AGENT_RELATIVE);
    expectSafeProjection(projected);
  });
});
