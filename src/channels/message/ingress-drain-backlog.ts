import type { ChannelIngressQueue } from "./ingress-queue.types.js";

const BACKLOG_PAGE_SIZE = 100;
// The caller skips blocked lanes itself; excluding them in the read only avoids reading their
// rows, so the list stays far below SQLite's bound-parameter limit after a wide outage.
const MAX_EXCLUDED_LANES = 1_000;

type BacklogQueue<TPayload, TMetadata> = Pick<
  ChannelIngressQueue<TPayload, TMetadata>,
  "listUnsettled" | "listPending" | "listClaims"
>;
type UnsettledRead = Parameters<NonNullable<ChannelIngressQueue<unknown>["listUnsettled"]>>[0];

// A release between separate reads can hide a lane's head from both collections.
export async function readIngressUnsettled<TPayload, TMetadata>(
  queue: BacklogQueue<TPayload, TMetadata>,
  read: UnsettledRead & { orderBy: "received" | "id" },
) {
  return queue.listUnsettled
    ? await queue.listUnsettled(read)
    : {
        pending: await queue.listPending({ limit: "all", orderBy: read.orderBy }),
        claims: await queue.listClaims(),
      };
}

/**
 * Reads the unsettled backlog for one drain pass. A paged read returns every claim with one
 * page of pending rows that skips `blockedLaneKeys`, read again before each page, so the
 * caller pays for the rows it reaches instead of every pending row. An unpaged read is one
 * whole snapshot. The caller keeps a lane blocked for the whole pass, so a claim released
 * between pages cannot expose a row behind its head.
 */
export async function* readIngressBacklogPages<TPayload, TMetadata>(
  queue: BacklogQueue<TPayload, TMetadata>,
  options: { orderBy: "received" | "id"; paged: boolean; blockedLaneKeys: ReadonlySet<string> },
) {
  let after: { receivedAt: number; id: string } | undefined;
  for (;;) {
    const { pending, claims } = await readIngressUnsettled(queue, {
      orderBy: options.orderBy,
      ...(options.paged && {
        pendingLimit: BACKLOG_PAGE_SIZE,
        after,
        excludeLaneKeys: [...options.blockedLaneKeys].slice(0, MAX_EXCLUDED_LANES),
      }),
    });
    // A queue may ignore the page options: a page that ends on the cursor made no progress.
    const last = pending.at(-1);
    const lastPage =
      !options.paged ||
      last === undefined ||
      pending.length !== BACKLOG_PAGE_SIZE ||
      (last.id === after?.id && last.receivedAt === after.receivedAt);
    yield { pending, claims, lastPage };
    if (lastPage) {
      return;
    }
    after = { receivedAt: last.receivedAt, id: last.id };
  }
}
