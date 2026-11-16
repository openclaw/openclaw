import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerOpenClawIdEnglish } from "../i18n/locales/en-openclaw-id.ts";
import { formatDurationHuman } from "../lib/format-duration.ts";
import type {
  OpenClawIdPeopleLink,
  OpenClawIdPublication,
  OpenClawIdStatusResult,
} from "../lib/openclaw-id/types.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

registerOpenClawIdEnglish();

// Access → People, the plugin page where the owner decides join requests.
const PEOPLE_PAGE_SEARCH = `?${new URLSearchParams({ plugin: "openclaw-id-access", id: "access" })}`;

function buildOpenClawIdKeyAttention(
  status: OpenClawIdStatusResult,
  publication?: OpenClawIdPublication | null,
): SidebarAttentionItem | null {
  if (status.channel !== "local_operator" || !status.link.linked || status.status.state === "off") {
    return null;
  }
  const refused = status.status.state === "keys_refused";
  if (!refused && !(publication?.state === "failed" && publication.code === "binding_superseded")) {
    return null;
  }
  return {
    type: "attention",
    category: "system",
    kind: "openClawIdKeys",
    severity: "error",
    icon: "key",
    requiresAction: true,
    dismissal: null,
    signature: JSON.stringify([
      status.link.clawId,
      refused ? status.status.reason : "binding_superseded",
    ]),
    label: t(
      refused
        ? status.status.reason === "key_mismatch"
          ? "openclawId.keysMismatch"
          : "openclawId.keysMissing"
        : "openclawId.bindingSuperseded",
    ),
    detail: t(refused ? "openclawId.keysRefusedDetail" : "openclawId.bindingSupersededDetail"),
    action: { kind: "openClawIdRecovery", label: t("openclawId.moveToNewKeys") },
  };
}

// The members and nodes waiting for the owner to decide.
function listJoinRequests(link: OpenClawIdPeopleLink) {
  return [
    ...(link.invites ?? []).map((invite) => ({
      kind: "member" as const,
      invite,
      name: invite.pending?.reported.displayName || invite.pending?.reported.email || invite.label,
    })),
    ...(link.nodeInvites ?? []).map((invite) => ({
      kind: "node" as const,
      invite,
      name: invite.label,
    })),
  ].flatMap(({ kind, invite, name }) => {
    const pending = invite.status === "pending" ? invite.pending : undefined;
    return pending
      ? [
          {
            kind,
            inviteId: invite.inviteId,
            name,
            requestedAt: pending.requestedAt,
            decideByMs: pending.decideBy * 1000,
          },
        ]
      : [];
  });
}

function joinRequestAttention(
  request: ReturnType<typeof listJoinRequests>[number],
  nowMs: number,
): SidebarAttentionItem {
  return {
    type: "attention",
    category: "system",
    kind: "openClawIdRequest",
    severity: "warning",
    icon: "users",
    requiresAction: true,
    dismissal: null,
    signature: JSON.stringify([request.kind, request.inviteId, request.requestedAt]),
    label: t(
      request.kind === "node" ? "openclawId.nodeAskedToJoin" : "openclawId.memberAskedToJoin",
      { name: request.name },
    ),
    detail: t("openclawId.joinRequestDetail"),
    meta: {
      status: t("openclawId.joinRequestTimeLeft", {
        time: formatDurationHuman(request.decideByMs - nowMs),
      }),
    },
    arrivedAtMs: request.requestedAt * 1000,
    action: { kind: "navigate", routeId: "plugin", search: PEOPLE_PAGE_SEARCH },
  };
}

// How often a request's time left is shown again: hourly while days remain, then each minute,
// then every few seconds in its last hour.
function timeLeftRefreshMs(remainingMs: number): number {
  return remainingMs > 86_400_000 ? 3_600_000 : remainingMs > 3_600_000 ? 60_000 : 5_000;
}

/** One read's Inbox rows; join requests count down and drop out as they expire. */
export type OpenClawIdAttention = {
  items(nowMs: number): SidebarAttentionItem[];
  /** When a pending join request's time left or presence next changes. */
  nextChangeAt(nowMs: number): number | undefined;
};

export async function readOpenClawIdAttention(
  client: GatewayBrowserClient,
  current: () => boolean,
): Promise<OpenClawIdAttention | null> {
  const status = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
  if (!current()) {
    return null;
  }
  // openclawId.people answers only owners: this claw's computer or an owner device.
  const link =
    status.status.state !== "keys_refused" &&
    status.status.state !== "off" &&
    status.owner &&
    status.link.linked
      ? (await client.request<{ link: OpenClawIdPeopleLink }>("openclawId.people", {})).link
      : null;
  const key = buildOpenClawIdKeyAttention(status, link?.publication);
  const requests = link ? listJoinRequests(link) : [];
  const browsers = link?.browserRequests ?? [];
  const pendingBrowsers = (nowMs: number) =>
    browsers.filter((request) => request.expiresAt * 1000 > nowMs);
  const pendingAt = (nowMs: number) => requests.filter((request) => request.decideByMs > nowMs);
  return {
    items: (nowMs) => [
      ...(key ? [key] : []),
      ...pendingAt(nowMs).map((request) => joinRequestAttention(request, nowMs)),
      ...pendingBrowsers(nowMs).map((request): SidebarAttentionItem => ({
        type: "attention",
        category: "system",
        kind: "openClawIdBrowserRequest",
        severity: "warning",
        icon: "monitor",
        requiresAction: true,
        dismissal: null,
        signature: JSON.stringify(["member-browser", request.requestId, request.requestedAt]),
        label: t("openclawId.browserRequestClaim", {
          name: request.displayName || request.email || t("openclawId.browserRequestMember"),
        }),
        detail: [
          t("openclawId.browserRequestContext", {
            browser: request.label,
            time: formatDurationHuman(request.expiresAt * 1000 - nowMs),
          }),
          request.email && request.email !== request.displayName ? request.email : null,
          request.location
            ? t("openclawId.browserRequestLocation", { location: request.location })
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        meta: {
          status: t("openclawId.browserRequestUnverified"),
          context: t("openclawId.browserRequestContext", {
            browser: request.label,
            time: formatDurationHuman(request.expiresAt * 1000 - nowMs),
          }),
        },
        arrivedAtMs: request.requestedAt * 1000,
        action: {
          kind: "openClawIdBrowserApproval",
          remote: status.channel === "tunnel",
          label: t("openclawId.approveNewDevice"),
        },
      })),
    ],
    nextChangeAt: (nowMs) => {
      const pending = [
        ...pendingAt(nowMs),
        ...pendingBrowsers(nowMs).map((request) => ({ decideByMs: request.expiresAt * 1000 })),
      ];
      return pending.length
        ? Math.min(
            ...pending.map((request) =>
              Math.min(request.decideByMs, nowMs + timeLeftRefreshMs(request.decideByMs - nowMs)),
            ),
          )
        : undefined;
    },
  };
}
