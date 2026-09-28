import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { filterAndSortSessionEntries, prepareSessionRowSelection } from "./session-utils-list.js";

it.runIf(process.env.OPENCLAW_SESSION_SELECTION_BENCH === "1")(
  "measures repeated selection across 2,300 resident rows",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      const store = Object.fromEntries(
        Array.from({ length: 2300 }, (_, index) => {
          const suffix =
            index % 20 === 0
              ? `cron:job-${index}:run:run-${index}`
              : index % 20 === 1
                ? `subagent:child-${index}`
                : index % 20 === 2
                  ? `matrix:channel:!Room${index}:example.org`
                  : index % 20 === 3
                    ? `signal:group:Opaque${index}`
                    : `dashboard:session-${index}`;
          return [`agent:main:${suffix}`, { sessionId: `session-${index}`, updatedAt: index + 1 }];
        }),
      );
      const projection = createSessionRowProjectionFixture({ cfg, store });
      try {
        for (const opts of [
          { limit: 50 },
          { limit: 50, agentId: "main", excludeSubagents: true },
        ] satisfies SessionsListParams[]) {
          const prepared = prepareSessionRowSelection(projection, opts);
          const select = () => filterAndSortSessionEntries(prepared);
          expect(select()).toHaveLength(50);
          for (let warmup = 0; warmup < 100; warmup++) {
            select();
          }
          const samples = [];
          for (let sample = 0; sample < 7; sample++) {
            const start = performance.now();
            for (let iteration = 0; iteration < 300; iteration++) {
              select();
            }
            samples.push((performance.now() - start) / 300);
          }
          console.log(
            JSON.stringify({
              opts,
              msPerSelection: samples,
              medianMs: samples.toSorted((a, b) => a - b)[3],
            }),
          );
        }
      } finally {
        projection.dispose();
      }
    });
  },
  120_000,
);
