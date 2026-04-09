/**
 * Per-agent Cartesia voice assignments.
 *
 * Every agent gets a unique Cartesia voice out of the box.
 * If a customer doesn't like a voice, they can swap to a backup
 * from the same-gender pool via the MC Voice Config panel, which
 * writes agents.list[i].tts.cartesiaVoiceId in openclaw.json.
 *
 * Resolution precedence:
 *   1. Explicit override in openclaw.json (agents.list[i].tts.cartesiaVoiceId)
 *   2. Default voice from AGENT_VOICE_MAP below
 *   3. Gender-based fallback (Victoria / Oliver)
 */

import type { AgentTtsConfig } from "../config/types.agents.js";

export type AgentGender = "male" | "female";

// ── Cartesia Voice Catalog (curated for business agents) ────────────

export type CartesiaVoiceEntry = {
  id: string;
  label: string;
  gender: AgentGender;
};

// Female voices (15 available)
export const CARTESIA_FEMALE_VOICES: CartesiaVoiceEntry[] = [
  { id: "dc30854e-e398-4579-9dc8-16f6cb2c19b9", label: "Victoria — Refined Coordinator", gender: "female" },
  { id: "e07c00bc-4134-4eae-9ea4-1a55fb45746b", label: "Brooke — Big Sister", gender: "female" },
  { id: "f786b574-daa5-4673-aa0c-cbe3e8534c02", label: "Katie — Friendly Fixer", gender: "female" },
  { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", label: "Jacqueline — Reassuring Agent", gender: "female" },
  { id: "f9836c6e-a0bd-460e-9d3c-f7299fa60f94", label: "Caroline — Southern Guide", gender: "female" },
  { id: "e8e5fffb-252c-436d-b842-8879b84445b6", label: "Cathy — Coworker", gender: "female" },
  { id: "62ae83ad-4f6a-430b-af41-a9bede9286ca", label: "Gemma — Decisive Agent", gender: "female" },
  { id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", label: "Skylar — Friendly Guide", gender: "female" },
  { id: "2f251ac3-89a9-4a77-a452-704b474ccd01", label: "Lucy — Capable Coordinator", gender: "female" },
  { id: "a4a16c5e-5902-4732-b9b6-2a48efd2e11b", label: "Grace — Helpful Hand", gender: "female" },
  { id: "a33f7a4c-100f-41cf-a1fd-5822e8fc253f", label: "Lauren — Lively Narrator", gender: "female" },
  { id: "1242fb95-7ddd-44ac-8a05-9e8a22a6137d", label: "Cindy — Receptionist", gender: "female" },
  { id: "d1d9c946-7cfc-4378-85a4-07d09827cb7e", label: "Jolene — Warm Storyteller", gender: "female" },
  { id: "0ee8beaa-db49-4024-940d-c7ea09b590b3", label: "Morgan — Executive Expert", gender: "female" },
  { id: "692846ad-1a6b-49b8-bfc5-86421fd41a19", label: "Thandi — Direct Dispatcher", gender: "female" },
];

// Male voices (13 available)
export const CARTESIA_MALE_VOICES: CartesiaVoiceEntry[] = [
  { id: "ee7ea9f8-c0c1-498c-9279-764d6b56d189", label: "Oliver — Customer Chap", gender: "male" },
  { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", label: "Blake — Helpful Agent", gender: "male" },
  { id: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", label: "Theo — Modern Narrator", gender: "male" },
  { id: "a5136bf9-224c-4d76-b823-52bd5efcffcc", label: "Jameson — Easygoing Support", gender: "male" },
  { id: "86e30c1d-714b-4074-a1f2-1cb6b552fb49", label: "Carson — Curious Conversationalist", gender: "male" },
  { id: "4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991", label: "George — Composed Consultant", gender: "male" },
  { id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7", label: "Ronald — Thinker", gender: "male" },
  { id: "87286a8d-7ea7-4235-a41a-dd9fa6630feb", label: "Henry — Plainspoken Guy", gender: "male" },
  { id: "4f7f1324-1853-48a6-b294-4e78e8036a83", label: "Casper — Gentle Narrator", gender: "male" },
  { id: "c8f7835e-28a3-4f0c-80d7-c1302ac62aae", label: "Alistair — Composed Consultant", gender: "male" },
  { id: "47c38ca4-5f35-497b-b1a3-415245fb35e1", label: "Daniel — Modern Assistant", gender: "male" },
  { id: "3e39e9a5-585c-4f5f-bac6-5e4905c51095", label: "Cole — Clear Communicator", gender: "male" },
  { id: "baf84392-fa95-4d44-8871-d32ee36b0e01", label: "Pieter — Polished Analyst", gender: "male" },
];

// ── Default Voice Assignments (unique per agent) ────────────────────
// Each agent gets a distinct Cartesia voice matched to their role/personality.
// Where we run short (13 male voices for 19 male agents), some agents share.

const AGENT_VOICE_MAP: Record<string, { voiceId: string; gender: AgentGender }> = {
  // ── Female agents (18) ──
  main:   { voiceId: "dc30854e-e398-4579-9dc8-16f6cb2c19b9", gender: "female" }, // Victoria — Refined Coordinator (Quinn's agent ID is "main")
  quinn:  { voiceId: "dc30854e-e398-4579-9dc8-16f6cb2c19b9", gender: "female" }, // Victoria — alias for sessionKey parsing
  nora:   { voiceId: "e07c00bc-4134-4eae-9ea4-1a55fb45746b", gender: "female" }, // Brooke — Big Sister
  maya:   { voiceId: "f786b574-daa5-4673-aa0c-cbe3e8534c02", gender: "female" }, // Katie — Friendly Fixer
  aria:   { voiceId: "a33f7a4c-100f-41cf-a1fd-5822e8fc253f", gender: "female" }, // Lauren — Lively Narrator
  lena:   { voiceId: "62ae83ad-4f6a-430b-af41-a9bede9286ca", gender: "female" }, // Gemma — Decisive Agent
  tess:   { voiceId: "f9836c6e-a0bd-460e-9d3c-f7299fa60f94", gender: "female" }, // Caroline — Southern Guide
  ivy:    { voiceId: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", gender: "female" }, // Jacqueline — Reassuring Agent
  zara:   { voiceId: "692846ad-1a6b-49b8-bfc5-86421fd41a19", gender: "female" }, // Thandi — Direct Dispatcher
  kira:   { voiceId: "0ee8beaa-db49-4024-940d-c7ea09b590b3", gender: "female" }, // Morgan — Executive Expert
  dara:   { voiceId: "a4a16c5e-5902-4732-b9b6-2a48efd2e11b", gender: "female" }, // Grace — Helpful Hand
  lexi:   { voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", gender: "female" }, // Skylar — Friendly Guide
  yara:   { voiceId: "1242fb95-7ddd-44ac-8a05-9e8a22a6137d", gender: "female" }, // Cindy — Receptionist
  cleo:   { voiceId: "2f251ac3-89a9-4a77-a452-704b474ccd01", gender: "female" }, // Lucy — Capable Coordinator
  elle:   { voiceId: "d1d9c946-7cfc-4378-85a4-07d09827cb7e", gender: "female" }, // Jolene — Warm Storyteller
  mia:    { voiceId: "e8e5fffb-252c-436d-b842-8879b84445b6", gender: "female" }, // Cathy — Coworker
  vera:   { voiceId: "e07c00bc-4134-4eae-9ea4-1a55fb45746b", gender: "female" }, // Brooke (shared w/ nora)
  kathie: { voiceId: "f786b574-daa5-4673-aa0c-cbe3e8534c02", gender: "female" }, // Katie (shared w/ maya)
  sage:   { voiceId: "a4a16c5e-5902-4732-b9b6-2a48efd2e11b", gender: "female" }, // Grace (shared w/ dara)

  // ── Male agents (19) ──
  jack:   { voiceId: "a167e0f3-df7e-4d52-a9c3-f949145efdab", gender: "male" },   // Blake — Helpful Agent
  cole:   { voiceId: "ee7ea9f8-c0c1-498c-9279-764d6b56d189", gender: "male" },   // Oliver — Customer Chap
  jim:    { voiceId: "4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991", gender: "male" },   // George — Composed Consultant
  chris:  { voiceId: "a5136bf9-224c-4d76-b823-52bd5efcffcc", gender: "male" },   // Jameson — Easygoing Support
  omar:   { voiceId: "baf84392-fa95-4d44-8871-d32ee36b0e01", gender: "male" },   // Pieter — Polished Analyst
  nick:   { voiceId: "86e30c1d-714b-4074-a1f2-1cb6b552fb49", gender: "male" },   // Carson — Curious Conversationalist
  josh:   { voiceId: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", gender: "male" },   // Theo — Modern Narrator
  dean:   { voiceId: "47c38ca4-5f35-497b-b1a3-415245fb35e1", gender: "male" },   // Daniel — Modern Assistant
  luis:   { voiceId: "87286a8d-7ea7-4235-a41a-dd9fa6630feb", gender: "male" },   // Henry — Plainspoken Guy
  max:    { voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7", gender: "male" },   // Ronald — Thinker
  troy:   { voiceId: "c8f7835e-28a3-4f0c-80d7-c1302ac62aae", gender: "male" },   // Alistair — Composed Consultant
  phil:   { voiceId: "3e39e9a5-585c-4f5f-bac6-5e4905c51095", gender: "male" },   // Cole — Clear Communicator
  seth:   { voiceId: "4f7f1324-1853-48a6-b294-4e78e8036a83", gender: "male" },   // Casper — Gentle Narrator
  jer:    { voiceId: "a167e0f3-df7e-4d52-a9c3-f949145efdab", gender: "male" },   // Blake (shared w/ jack)
  jude:   { voiceId: "a5136bf9-224c-4d76-b823-52bd5efcffcc", gender: "male" },   // Jameson (shared w/ chris)
  jake:   { voiceId: "86e30c1d-714b-4074-a1f2-1cb6b552fb49", gender: "male" },   // Carson (shared w/ nick)
  jared:  { voiceId: "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e", gender: "male" },   // Theo (shared w/ josh)
  steve:  { voiceId: "47c38ca4-5f35-497b-b1a3-415245fb35e1", gender: "male" },   // Daniel (shared w/ dean)
  mark:   { voiceId: "4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991", gender: "male" },   // George (shared w/ jim)
};

// ── Public API ──────────────────────────────────────────────────────

export function resolveAgentGender(agentId: string | undefined): AgentGender | undefined {
  if (!agentId) return undefined;
  return AGENT_VOICE_MAP[agentId.toLowerCase()]?.gender ?? undefined;
}

export type AgentVoiceOverrides = {
  cartesiaVoiceId?: string;
  edgeVoice?: string;
};

/**
 * Resolve the Cartesia voice ID for an agent.
 *
 * 1. Check per-agent config override (openclaw.json → agents.list[i].tts.cartesiaVoiceId)
 * 2. Fall back to AGENT_VOICE_MAP default
 * 3. Final fallback: Victoria (female) / Oliver (male)
 */
export function resolveAgentVoiceOverrides(
  agentId: string | undefined,
  provider: string,
  agentsList?: Array<{ id: string; tts?: AgentTtsConfig }>,
): AgentVoiceOverrides {
  if (!agentId) return {};

  const lower = agentId.toLowerCase();

  // Check per-agent config override first
  if (agentsList) {
    const entry = agentsList.find((a) => a.id.toLowerCase() === lower);
    if (entry?.tts?.cartesiaVoiceId) {
      if (provider === "cartesia") {
        return { cartesiaVoiceId: entry.tts.cartesiaVoiceId };
      }
      // For edge fallback, map gender to edge voice
      const gender = AGENT_VOICE_MAP[lower]?.gender;
      if (provider === "edge" && gender) {
        return { edgeVoice: gender === "male" ? "en-US-AndrewNeural" : "en-US-AvaNeural" };
      }
      return {};
    }
  }

  // Default from voice map
  const mapped = AGENT_VOICE_MAP[lower];
  if (!mapped) return {};

  if (provider === "cartesia") {
    return { cartesiaVoiceId: mapped.voiceId };
  }
  if (provider === "edge") {
    return { edgeVoice: mapped.gender === "male" ? "en-US-AndrewNeural" : "en-US-AvaNeural" };
  }
  return {};
}

/**
 * Get the default voice info for an agent (for display in MC UI).
 */
export function getAgentDefaultVoice(agentId: string): { voiceId: string; label: string; gender: AgentGender } | undefined {
  const lower = agentId.toLowerCase();
  const mapped = AGENT_VOICE_MAP[lower];
  if (!mapped) return undefined;

  const allVoices = [...CARTESIA_FEMALE_VOICES, ...CARTESIA_MALE_VOICES];
  const voice = allVoices.find((v) => v.id === mapped.voiceId);
  return {
    voiceId: mapped.voiceId,
    label: voice?.label ?? "Custom Voice",
    gender: mapped.gender,
  };
}

/**
 * Get backup voice options for an agent (same gender, excluding current).
 */
export function getAgentBackupVoices(agentId: string): CartesiaVoiceEntry[] {
  const lower = agentId.toLowerCase();
  const mapped = AGENT_VOICE_MAP[lower];
  if (!mapped) return [];

  const pool = mapped.gender === "female" ? CARTESIA_FEMALE_VOICES : CARTESIA_MALE_VOICES;
  // Return all voices for that gender (current voice included so the dropdown shows it selected)
  return pool;
}
