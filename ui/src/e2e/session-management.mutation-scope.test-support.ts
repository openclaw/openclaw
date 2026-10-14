import { writeSync } from "node:fs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { SessionDataController } from "../components/session-data-controller.ts";
import type { ControlUiMockGateway, MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

type MutationCase = { operation: "rename" | "batch archive"; filter: "Active" | "All" };

export async function installMutationScopeDiagnostics(page: Page, scenario: MutationCase) {
  const prefix = "[session-mutation-pagination] ";
  let records = 0;
  const log = (message: { text(): string }) => {
    const text = message.text();
    if (text.startsWith(prefix) && text.length <= 2_000 && records < 32) {
      records += 1;
      writeSync(2, `${text}\n`);
    }
  };
  page.on("console", log);
  page.once("close", () => page.off("console", log));
  await page.addInitScript(
    ({ prefix: logPrefix, scenario: caseInfo }) => {
      const agentLabel = (agent: string | null) =>
        agent === "main" || agent === "research" ? agent : agent === null ? null : "other";
      for (const { eventName, phase, capture } of [
        { eventName: "pointerdown", phase: "pointerdown", capture: true },
        { eventName: "click", phase: "click", capture: true },
        { eventName: "click", phase: "after-click", capture: false },
      ]) {
        document.addEventListener(
          eventName,
          (event) => {
            const button =
              event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>(
                    ".sidebar-session-pagination--roster button",
                  )
                : null;
            const sidebar = button?.closest<
              HTMLElement & { sessionData: SessionDataController; expandedAgentId(): string }
            >("openclaw-app-sidebar");
            if (!button || !sidebar) {
              return;
            }
            const record = (recordedPhase: string) => {
              const data = sidebar.sessionData;
              const result = data.sessionsResult;
              const keys = new Set(result?.sessions.map((row) => row.key));
              const requests = (
                window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
              ).openclawControlUiE2eGateway?.findRequests("sessions.list");
              console.info(
                logPrefix +
                  JSON.stringify({
                    ...caseInfo,
                    phase: recordedPhase,
                    trusted: event.isTrusted,
                    disabled: button.disabled,
                    loading: data.sessionsLoading,
                    selectedAgent: agentLabel(sidebar.expandedAgentId()),
                    listAgent: agentLabel(data.sessionsAgentId),
                    cursor: result?.nextOffset ?? null,
                    count: result?.sessions.length ?? 0,
                    hasMore: result?.hasMore === true,
                    hasNew: keys.has("agent:research:new-after-completion"),
                    hasSecond: keys.has("agent:research:second"),
                    hasOlder: keys.has("agent:research:older"),
                    secondRendered: Boolean(
                      sidebar.querySelector(
                        '.sidebar-recent-session[data-session-key="agent:research:second"]',
                      ),
                    ),
                    olderRendered: Boolean(
                      sidebar.querySelector(
                        '.sidebar-recent-session[data-session-key="agent:research:older"]',
                      ),
                    ),
                    listRequests: requests?.length ?? 0,
                  }),
              );
            };
            record(phase);
          },
          capture,
        );
      }
    },
    { prefix, scenario },
  );
}

export function logMutationScopeRequests(requests: MockGatewayRequest[], scenario: MutationCase) {
  const summaries = requests.slice(-32).map(({ params }) => {
    const value = asNullableRecord(params) ?? {};
    const agentId = value.agentId;
    return {
      agent: agentId === "main" || agentId === "research" ? agentId : "other",
      archived: value.archived === "all" ? "all" : value.archived === true ? "archived" : "active",
      offset: typeof value.offset === "number" ? value.offset : null,
      limit: typeof value.limit === "number" ? value.limit : null,
      derivedTitles: value.includeDerivedTitles === true,
      lastMessage: value.includeLastMessage === true,
      boardOnly: value.hasBoard === true,
      childQuery: typeof value.spawnedBy === "string",
    };
  });
  writeSync(
    2,
    `[session-mutation-pagination] ${JSON.stringify({ ...scenario, phase: "final-requests", total: requests.length, requests: summaries })}\n`,
  );
}
