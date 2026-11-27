import type { RuntimeLogger } from "../plugins/runtime/types.js";
import type { MeetingBrowserTab, MeetingSessionRecord } from "./session-types.js";

type BrowserTabOptions<TSession, TTab extends MeetingBrowserTab> = {
  getBrowser(session: TSession): { nodeId?: string; tab?: TTab } | undefined;
  setBrowserTab(session: TSession, tab: TTab | undefined): void;
  releaseBrowserTab(session: TSession): Promise<boolean | undefined>;
  sameMeetingUrl(left: string | undefined, right: string | undefined): boolean;
  logger: Pick<RuntimeLogger, "warn">;
  logScope: string;
  formatError(error: unknown): string;
};

export type MeetingBrowserTabRelease<TTab> = {
  messages: { noTrackedTab: string; sharedTab: string; leaveFailed(error: string): string };
  leave: (tab: TTab) => Promise<{ left: boolean; note: string }>;
};

export const releasedMeetingBrowserHealth = {
  captioning: false,
  audioInputRouted: false,
  audioOutputRouted: false,
  providerConnected: false,
  realtimeReady: false,
  audioInputActive: false,
  audioOutputActive: false,
} as const;

export async function leaveTrackedMeetingBrowserTab<
  TSession extends MeetingSessionRecord,
  TTab extends MeetingBrowserTab,
>(
  sessions: Iterable<TSession>,
  options: Pick<BrowserTabOptions<TSession, TTab>, "getBrowser" | "formatError">,
  session: TSession,
  { messages, leave }: MeetingBrowserTabRelease<TTab>,
): Promise<{ left?: boolean; note: string }> {
  const browser = options.getBrowser(session);
  const tab = browser?.tab;
  if (!tab) {
    return { left: false, note: messages.noTrackedTab };
  }
  // Target IDs belong to one browser route. Another active session on that route keeps the tab.
  for (const other of sessions) {
    if (
      other.id === session.id ||
      other.state !== "active" ||
      other.transport !== session.transport
    ) {
      continue;
    }
    const owner = options.getBrowser(other);
    if (owner?.tab?.targetId === tab.targetId && owner.nodeId === browser.nodeId) {
      return { note: messages.sharedTab };
    }
  }
  try {
    return await leave(tab);
  } catch (error) {
    return { left: false, note: messages.leaveFailed(options.formatError(error)) };
  }
}

export function inheritMeetingBrowserTabOwnership<
  TSession extends MeetingSessionRecord,
  TTab extends MeetingBrowserTab,
>(
  sessions: Iterable<TSession>,
  options: Pick<BrowserTabOptions<TSession, TTab>, "getBrowser" | "sameMeetingUrl">,
  params: {
    session: TSession;
    transport: TSession["transport"];
    nodeId?: string;
    meetingUrl: string;
    tab?: TTab;
  },
): TTab | undefined {
  if (!params.tab) {
    return undefined;
  }
  const inherited = [...sessions].some((session) => {
    const browser = options.getBrowser(session);
    const browserTab = browser?.tab;
    return (
      session.transport === params.transport &&
      options.sameMeetingUrl(session.url, params.meetingUrl) &&
      browser?.nodeId === params.nodeId &&
      browserTab?.targetId === params.tab?.targetId &&
      browserTab?.openedByPlugin === true
    );
  });
  return inherited ? { ...params.tab, openedByPlugin: true } : params.tab;
}

export async function settleMeetingRetainedBrowserTabs<
  TSession extends MeetingSessionRecord,
  TTab extends MeetingBrowserTab,
>(
  options: Pick<
    BrowserTabOptions<TSession, TTab>,
    "getBrowser" | "setBrowserTab" | "releaseBrowserTab"
  >,
  retained: Array<{ session: TSession; tab: TTab }>,
  adopted?: { transport: TSession["transport"]; nodeId?: string; tab: TTab },
): Promise<boolean> {
  let settled = true;
  for (let index = 0; index < retained.length;) {
    const retainedTab = retained[index];
    if (!retainedTab) {
      break;
    }
    const { session, tab } = retainedTab;
    const browser = options.getBrowser(session);
    const adoptedThisTab =
      adopted?.transport === session.transport &&
      adopted.nodeId === browser?.nodeId &&
      adopted.tab.targetId === tab.targetId;
    if (adoptedThisTab) {
      options.setBrowserTab(session, undefined);
      retained.splice(index, 1);
      continue;
    }
    if ((await options.releaseBrowserTab(session)) === false) {
      settled = false;
      index += 1;
      continue;
    }
    // Consume only after settlement succeeds. A rejection leaves this entry and the
    // remaining tail available to the failed-join rollback path for another attempt.
    retained.splice(index, 1);
  }
  return settled;
}

export async function settleMeetingRetainedBrowserTabsAfterFailure<
  TSession extends MeetingSessionRecord,
  TTab extends MeetingBrowserTab,
>(
  options: BrowserTabOptions<TSession, TTab>,
  retained: Array<{ session: TSession; tab: TTab }>,
): Promise<void> {
  // Failed reassignment has no future owner for retained tabs. Try twice while
  // preserving entries between attempts, but never replace the original join error.
  for (let attempt = 0; attempt < 2 && retained.length > 0; attempt += 1) {
    try {
      if (await settleMeetingRetainedBrowserTabs(options, retained)) {
        return;
      }
    } catch (error) {
      options.logger.warn(
        `${options.logScope} retained browser cleanup failed: ${options.formatError(error)}`,
      );
    }
  }
  if (retained.length > 0) {
    options.logger.warn(
      `${options.logScope} retained browser cleanup incomplete after failed join`,
    );
  }
}
