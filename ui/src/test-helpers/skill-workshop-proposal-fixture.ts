import { vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import type { SkillWorkshopProposal } from "../lib/skill-workshop/index.ts";
import {
  createSkillWorkshopState,
  type SkillWorkshopContext,
  type SkillWorkshopState,
} from "../pages/skill-workshop/proposals.ts";
import { createTestGatewayClient } from "./gateway-client.ts";
import { gatewayHelloForMethods } from "./gateway-methods.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

export const ISO_NOW = "2026-06-16T12:00:00.000Z";
const DRAFT_HASH = "a".repeat(64);
export const REVISION_HASH = "b".repeat(64);
export const UPDATED_REVISION_HASH = "c".repeat(64);

export function createFixture(
  overrides: Partial<SkillWorkshopState> = {},
  snapshotOverrides: Partial<ApplicationGatewaySnapshot> = {},
  methods: string[] = ["skills.proposals.list", "skills.proposals.inspect"],
): {
  state: SkillWorkshopState;
  context: SkillWorkshopContext;
  request: ReturnType<typeof vi.fn<TestRequest>>;
  snapshot: ApplicationGatewaySnapshot;
} {
  const request = vi.fn<TestRequest>();
  const snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(methods),
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
    ...snapshotOverrides,
  };
  const context: SkillWorkshopContext = {
    agentSelection: {
      get state() {
        return { selectedId: snapshot.assistantAgentId, scopeId: snapshot.assistantAgentId };
      },
    },
    gateway: {
      get snapshot() {
        return snapshot;
      },
      connection: { gatewayUrl: "", token: "", bootstrapToken: "", password: "" },
      connectionRevision: 0,
      eventLog: [],
      eventLogRevision: 0,
      connect: vi.fn(),
      setSessionKey: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeEventLog: vi.fn(() => () => {}),
      subscribeEvents: vi.fn(() => () => {}),
    },
  };
  return {
    state: { ...createSkillWorkshopState(), skillWorkshopMode: "suggestions", ...overrides },
    context,
    request,
    snapshot,
  };
}

export function manifest(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    installedSkills: [],
    updatedAt: ISO_NOW,
    proposals: [
      {
        id: "proposal-1",
        kind: "create",
        status,
        title: "Inbox Cleaner",
        description: "Clean inbox triage",
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
        createdAt: ISO_NOW,
        updatedAt: ISO_NOW,
        scanState: "clean",
        revisionHash: REVISION_HASH,
      },
    ],
  };
}

export function inspectResult(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    record: {
      id: "proposal-1",
      kind: "create",
      status,
      title: "Inbox Cleaner",
      description: "Clean inbox triage",
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
      proposedVersion: "v1",
      draftHash: DRAFT_HASH,
      target: {
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
      },
    },
    revisionHash: REVISION_HASH,
    content: "Review unread mail and archive low-priority threads.",
    supportFiles: [],
  };
}

export function proposal(overrides: Partial<SkillWorkshopProposal> = {}): SkillWorkshopProposal {
  return {
    key: "proposal-1",
    kind: "update",
    slug: "inbox-cleaner",
    name: "Inbox Cleaner",
    oneLine: "Clean inbox triage",
    body: "Review unread mail.",
    status: "pending",
    version: 1,
    revisionHash: REVISION_HASH,
    createdAt: Date.parse(ISO_NOW),
    updatedAt: Date.parse(ISO_NOW),
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    bodyLoaded: true,
    ...overrides,
  };
}

export function proposalDecision(expectedRevisionHash: string | null = REVISION_HASH) {
  return { proposalId: "proposal-1", expectedRevisionHash };
}

// The mutation RPC returns the authoritative terminal record: apply wraps it
// in `{ record, targetSkillFile }`, reject returns the bare record.
export function recordFrom(status: SkillWorkshopProposal["status"]) {
  return {
    id: "proposal-1",
    kind: "create",
    status,
    title: "Inbox Cleaner",
    description: "Clean inbox triage",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    proposedVersion: "v1",
    draftHash: DRAFT_HASH,
    origin: { agentId: "research", sessionKey: "main" },
    target: { skillName: "Inbox Cleaner", skillKey: "inbox-cleaner" },
  };
}

export function clearNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}
