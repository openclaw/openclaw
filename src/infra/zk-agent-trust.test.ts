import { describe, expect, it } from "vitest";
import {
  AccessWitnessRecorder,
  MerkleTree,
  issueAccessPolicy,
  verifyAccessProof,
  verifyMerklePath,
  verifyPolicyMac,
} from "./zk-agent-trust.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const GATEWAY_KEY = Buffer.from("test-gateway-master-secret-32byt", "utf8");
const AGENT_ID = "agent:test:session1";
const SESSION_ID = "session-abc-123";
const ALLOWED = [
  "tool:read_file:/workspace/readme.md",
  "channel:telegram:chat_12345",
  "tool:bash:echo",
];

// ── MerkleTree ────────────────────────────────────────────────────────────────

describe("MerkleTree", () => {
  it("produces a deterministic root from the same leaves", () => {
    const t1 = new MerkleTree(["aabbcc", "ddeeff"]);
    const t2 = new MerkleTree(["aabbcc", "ddeeff"]);
    expect(t1.root()).toBe(t2.root());
  });

  it("root is order-independent (leaves are sorted internally)", () => {
    const t1 = new MerkleTree(["aabbcc", "ddeeff"]);
    const t2 = new MerkleTree(["ddeeff", "aabbcc"]);
    expect(t1.root()).toBe(t2.root());
  });

  it("different leaves produce different roots", () => {
    const t1 = new MerkleTree(["aabbcc"]);
    const t2 = new MerkleTree(["aabbdd"]);
    expect(t1.root()).not.toBe(t2.root());
  });

  it("single-leaf tree has valid inclusion path", () => {
    const leaf = "deadbeef".padEnd(64, "0");
    const tree = new MerkleTree([leaf]);
    const path = tree.inclusionPath(leaf);
    expect(path).toBeDefined();
    expect(verifyMerklePath(path!, tree.root())).toBe(true);
  });

  it("multi-leaf inclusion paths verify correctly", () => {
    const leaves = ["aabb".padEnd(64, "0"), "ccdd".padEnd(64, "0"), "eeff".padEnd(64, "0")];
    const tree = new MerkleTree(leaves);
    const root = tree.root();
    for (const leaf of leaves) {
      const path = tree.inclusionPath(leaf);
      expect(path).toBeDefined();
      expect(verifyMerklePath(path!, root)).toBe(true);
    }
  });

  it("returns undefined for a leaf not in the tree", () => {
    const tree = new MerkleTree(["aabbcc"]);
    expect(tree.inclusionPath("000000")).toBeUndefined();
  });

  it("tampered path fails verification", () => {
    const leaf = "deadbeef".padEnd(64, "0");
    const tree = new MerkleTree([leaf, "cafebabe".padEnd(64, "0")]);
    const path = tree.inclusionPath(leaf)!;
    const tampered = { ...path, siblings: ["00".padEnd(64, "0")] };
    expect(verifyMerklePath(tampered, tree.root())).toBe(false);
  });
});

// ── Policy issuance + MAC ─────────────────────────────────────────────────────

describe("issueAccessPolicy / verifyPolicyMac", () => {
  it("issues a valid policy and verifies the MAC", () => {
    const policy = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: ALLOWED,
      gatewayKey: GATEWAY_KEY,
    });
    expect(policy.agentId).toBe(AGENT_ID);
    expect(policy.sessionId).toBe(SESSION_ID);
    expect(policy.policyRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPolicyMac(policy, GATEWAY_KEY)).toBe(true);
  });

  it("policy MAC fails with a wrong gateway key", () => {
    const policy = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: ALLOWED,
      gatewayKey: GATEWAY_KEY,
    });
    const wrongKey = Buffer.from("wrong-key-32-bytes-wrong-key----", "utf8");
    expect(verifyPolicyMac(policy, wrongKey)).toBe(false);
  });

  it("policy root is deterministic for the same resource set", () => {
    const p1 = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: ALLOWED,
      gatewayKey: GATEWAY_KEY,
    });
    const p2 = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: [...ALLOWED].reverse(), // reversed order — should not matter
      gatewayKey: GATEWAY_KEY,
    });
    expect(p1.policyRoot).toBe(p2.policyRoot);
  });
});

// ── Witness recording ─────────────────────────────────────────────────────────

describe("AccessWitnessRecorder", () => {
  it("records commitments that are hex strings", () => {
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    const c = recorder.record(ALLOWED[0]!);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same resource produces different commitments each time (nonce)", () => {
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    const c1 = recorder.record(ALLOWED[0]!);
    const c2 = recorder.record(ALLOWED[0]!);
    expect(c1).not.toBe(c2);
  });

  it("sealed witness has matching agentId/sessionId", () => {
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    recorder.record(ALLOWED[0]!);
    const witness = recorder.seal();
    expect(witness.agentId).toBe(AGENT_ID);
    expect(witness.sessionId).toBe(SESSION_ID);
  });

  it("sealed witness accessRoot is a 64-char hex string", () => {
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    for (const r of ALLOWED) {
      recorder.record(r);
    }
    const witness = recorder.seal();
    expect(witness.accessRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Full proof generation + verification ──────────────────────────────────────

describe("generateProof / verifyAccessProof", () => {
  function buildScenario(accessed: string[]) {
    const policy = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: ALLOWED,
      gatewayKey: GATEWAY_KEY,
    });
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    for (const r of accessed) {
      recorder.record(r);
    }
    const proof = recorder.generateProof(policy, GATEWAY_KEY, ALLOWED);
    return { policy, proof };
  }

  it("proof verifies when agent accessed only allowed resources", () => {
    const { policy, proof } = buildScenario([ALLOWED[0]!, ALLOWED[1]!]);
    expect(verifyAccessProof(proof, GATEWAY_KEY, policy)).toEqual({ valid: true });
  });

  it("proof verifies for a single access", () => {
    const { policy, proof } = buildScenario([ALLOWED[0]!]);
    expect(verifyAccessProof(proof, GATEWAY_KEY, policy)).toEqual({ valid: true });
  });

  it("proof verifies for all allowed resources accessed", () => {
    const { policy, proof } = buildScenario(ALLOWED);
    expect(verifyAccessProof(proof, GATEWAY_KEY, policy)).toEqual({ valid: true });
  });

  it("proof verifies for zero accesses", () => {
    const { policy, proof } = buildScenario([]);
    expect(verifyAccessProof(proof, GATEWAY_KEY, policy)).toEqual({ valid: true });
  });

  it("proof fails verification with wrong gateway key", () => {
    const { policy, proof } = buildScenario([ALLOWED[0]!]);
    const wrongKey = Buffer.from("wrong-key-32-bytes-wrong-key----", "utf8");
    const result = verifyAccessProof(proof, wrongKey, policy);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/MAC/i);
  });

  it("throws when agent accesses resource outside policy", () => {
    const policy = issueAccessPolicy({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      allowedResources: ALLOWED,
      gatewayKey: GATEWAY_KEY,
    });
    const recorder = new AccessWitnessRecorder(AGENT_ID, SESSION_ID);
    recorder.record("tool:read_file:/etc/passwd"); // unauthorized
    expect(() => recorder.generateProof(policy, GATEWAY_KEY, ALLOWED)).toThrow(
      /unauthorized resource/,
    );
  });

  it("tampered proof entry fails Merkle path verification", () => {
    const { policy, proof } = buildScenario([ALLOWED[0]!]);
    const tampered = {
      ...proof,
      entries: proof.entries.map((e) => ({
        ...e,
        accessPath: {
          ...e.accessPath,
          leaf: "00".padEnd(64, "0"), // corrupt leaf
        },
      })),
    };
    const result = verifyAccessProof(tampered, GATEWAY_KEY, policy);
    expect(result.valid).toBe(false);
  });

  it("proof fails if agentId is mismatched", () => {
    const { policy, proof } = buildScenario([ALLOWED[0]!]);
    const result = verifyAccessProof({ ...proof, agentId: "other-agent" }, GATEWAY_KEY, policy);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/agentId/);
  });
});
