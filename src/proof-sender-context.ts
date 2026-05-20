import { listChannelAgentTools } from "./agents/channel-tools.js";
import type { ChannelPlugin } from "./channels/plugins/types.js";
import type { OpenClawConfig } from "./config/config.js";
/**
 * Proof script: verify that listChannelAgentTools forwards
 * requesterSenderId and senderIsOwner to ChannelAgentToolFactory.
 *
 * Run from repo root with:  npx tsx src/proof-sender-context.ts
 */
import { setActivePluginRegistry } from "./plugins/runtime.js";
import { createTestRegistry } from "./test-utils/channel-plugins.js";

// --- mock factory that captures what it receives ---
let capturedParams: Record<string, unknown> | null = null;

const mockFactory = (params: {
  cfg?: OpenClawConfig;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
}) => {
  capturedParams = { ...params };
  return []; // no actual tools needed for the proof
};

const plugin: ChannelPlugin = {
  id: "proof",
  meta: {
    id: "proof",
    label: "Proof",
    selectionLabel: "Proof",
    docsPath: "/channels/proof",
    blurb: "proof plugin",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  agentTools: mockFactory as ChannelPlugin["agentTools"],
};

setActivePluginRegistry(createTestRegistry([{ pluginId: "proof", source: "test", plugin }]));

// --- Test 1: call WITH sender params ---
capturedParams = null;
listChannelAgentTools({
  cfg: {} as OpenClawConfig,
  requesterSenderId: "user-42",
  senderIsOwner: false,
});

const test1Pass =
  capturedParams !== null &&
  capturedParams.requesterSenderId === "user-42" &&
  capturedParams.senderIsOwner === false;

console.log(`[Test 1] Factory receives sender params: ${test1Pass ? "PASS ✓" : "FAIL ✗"}`);
if (capturedParams) {
  console.log(`  requesterSenderId = ${JSON.stringify(capturedParams.requesterSenderId)}`);
  console.log(`  senderIsOwner     = ${JSON.stringify(capturedParams.senderIsOwner)}`);
}

// --- Test 2: call WITHOUT sender params (backward compat) ---
capturedParams = null;
listChannelAgentTools({ cfg: {} as OpenClawConfig });

const test2Pass =
  capturedParams !== null &&
  capturedParams.requesterSenderId === undefined &&
  capturedParams.senderIsOwner === undefined;

console.log(`[Test 2] Backward compat (no sender params): ${test2Pass ? "PASS ✓" : "FAIL ✗"}`);

// --- Test 3: owner sender ---
capturedParams = null;
listChannelAgentTools({
  cfg: {} as OpenClawConfig,
  requesterSenderId: "owner-1",
  senderIsOwner: true,
});

const test3Pass =
  capturedParams !== null &&
  capturedParams.requesterSenderId === "owner-1" &&
  capturedParams.senderIsOwner === true;

console.log(`[Test 3] Owner sender forwarded correctly: ${test3Pass ? "PASS ✓" : "FAIL ✗"}`);

// --- summary ---
const allPass = test1Pass && test2Pass && test3Pass;
console.log(`\nOverall: ${allPass ? "ALL PASSED ✓" : "SOME FAILED ✗"}`);
process.exit(allPass ? 0 : 1);
