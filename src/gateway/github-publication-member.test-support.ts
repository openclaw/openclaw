import { onTestFinished } from "vitest";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPolicyFixture,
  guestScopes,
  requireVisitorPublicationPolicy,
} from "./github-publication-requester.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";

export async function createPublicationMemberFixture() {
  return configurePublicationMember(await createRequesterPolicyFixture());
}

export function configurePublicationMember<
  T extends Awaited<ReturnType<typeof createRequesterPolicyFixture>>,
>(f: T) {
  f.config.gateway!.openclawId = { enabled: true };
  f.config.gateway!.roles!.definitions.operator = {
    scopes: ["operator.read", "operator.write"],
    agents: "*",
    sessions: { others: "write" },
  };
  const principal = {
    kind: "member" as const,
    peerKey: `iroh:${"ab".repeat(32)}`,
    accountId: "publication-member",
    role: "operator",
    authority: { clawId: "publication-claw", rootPub: "publication-root", listedSeq: 1 },
  };
  let current: OpenClawIdTunnelPrincipal | undefined = principal;
  setOpenClawIdTunnelPrincipalLookup(() => current);
  const config = requireVisitorPublicationPolicy(f);
  const capture = () =>
    createGitHubPublicationRequesterFixture({
      profileId: f.guestProfile,
      scopes: guestScopes,
      ...f.guestSource.session,
      openclawIdPrincipal: principal,
    });
  return {
    ...f,
    config,
    principal,
    capture,
    setMember: (next: typeof current) => {
      current = next;
    },
  };
}

export async function restorePublicationMemberRequester(
  json: string,
  f: Awaited<ReturnType<typeof createRequesterPolicyFixture>>,
) {
  const requester = await restoreGitHubPublicationRequester(
    json,
    f.guestSource.session,
    f.guestSource.context.getCommittedRuntimeConfig,
  );
  onTestFinished(requester.release);
  return requester;
}

export function memberRetryMismatchCases() {
  const principal = {
    kind: "member" as const,
    peerKey: `iroh:${"ab".repeat(32)}`,
    accountId: "publication-member",
    role: "operator",
    authority: { clawId: "publication-claw", rootPub: "publication-root", listedSeq: 1 },
  };
  const origin = {
    agentId: "main",
    sessionKey: "agent:main:source",
    sessionId: "source",
    lifecycleRevision: "original",
  };
  const historical: GitHubPublicationRequesterSnapshot = {
    version: 1,
    actor: { kind: "operator", profileId: "original-profile" },
    scopes: guestScopes,
    grant: {
      pluginId: "visitor-access",
      grantId: "11111111-1111-4111-8111-111111111111",
      aliasBindingIds: [],
    },
    origin,
  };
  const member = { ...historical, openclawIdPrincipal: principal, grant: null };
  type Case = {
    change: string;
    original: GitHubPublicationRequesterSnapshot;
    current: GitHubPublicationRequesterSnapshot;
  };
  const changed: Array<[string, Partial<GitHubPublicationRequesterSnapshot>]> = [
    ["another actor kind", { actor: { kind: "system" } }],
    ["another profile", { actor: { kind: "operator", profileId: "other-profile" } }],
    ["different scopes", { scopes: ["operator.write"] }],
    ["another agent", { origin: { ...origin, agentId: "other" } }],
    ["another session key", { origin: { ...origin, sessionKey: "agent:main:other" } }],
    ["another session id", { origin: { ...origin, sessionId: "other" } }],
    ["another session lifecycle", { origin: { ...origin, lifecycleRevision: "other" } }],
    ["missing source session", { origin: undefined }],
    ["a non-member losing its grant", { openclawIdPrincipal: undefined }],
    [
      "a different member grant",
      { grant: { ...historical.grant!, grantId: "22222222-2222-4222-8222-222222222222" } },
    ],
  ];
  const cases: Case[] = changed.map(([change, overrides]) => ({
    change,
    original: historical,
    current: { ...member, ...overrides },
  }));
  cases.push(
    {
      change: "a non-member replacing its grant",
      original: historical,
      current: {
        ...historical,
        grant: { ...historical.grant!, grantId: "22222222-2222-4222-8222-222222222222" },
      },
    },
    {
      change: "missing accepted member principal",
      original: member,
      current: { ...member, openclawIdPrincipal: undefined },
    },
  );
  for (const [change, currentPrincipal] of [
    ["another member peer", { ...principal, peerKey: `iroh:${"cd".repeat(32)}` }],
    ["another member account", { ...principal, accountId: "other" }],
    ["another member role", { ...principal, role: "viewer" }],
    ["another claw", { ...principal, authority: { ...principal.authority, clawId: "other" } }],
    ["another root", { ...principal, authority: { ...principal.authority, rootPub: "other" } }],
    ["another listing", { ...principal, authority: { ...principal.authority, listedSeq: 2 } }],
  ] as const) {
    cases.push({
      change,
      original: member,
      current: { ...member, openclawIdPrincipal: currentPrincipal },
    });
  }
  return cases;
}
