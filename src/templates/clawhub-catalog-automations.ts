import type { TemplatesCatalogDetailResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { formatExactDuration } from "../infra/format-time/format-duration-exact.js";
import { readClawHubCatalogInstructionBytes } from "./clawhub-preview-content.js";
import type { ResolvedClawHubSource } from "./clawhub-source-artifact.js";
import { planTemplatePortableAutomation } from "./portable-automation.js";
import type { TemplateAddPlanAction } from "./types.js";

type CatalogAutomation = NonNullable<
  TemplatesCatalogDetailResult["detail"]["contents"]
>["automations"][number];

export async function projectClawHubCatalogAutomations(input: {
  verified: ResolvedClawHubSource;
  rootDir: string;
  instructions: Array<{ name: string; source: string }>;
}): Promise<CatalogAutomation[]> {
  const { manifest } = input.verified;
  const heartbeatFile = input.instructions.find((file) => file.name === "HEARTBEAT.md");
  const actions: TemplateAddPlanAction[] = heartbeatFile
    ? [
        {
          kind: "workspaceFile",
          id: "HEARTBEAT.md",
          action: "write",
          target: "HEARTBEAT.md",
          blocked: false,
        },
      ]
    : [];
  planTemplatePortableAutomation({
    actions,
    heartbeat: manifest.agent.heartbeat,
    content: heartbeatFile
      ? await readClawHubCatalogInstructionBytes({
          sourcePath: heartbeatFile.source,
          verified: input.verified,
          rootDir: input.rootDir,
        })
      : undefined,
    config: {},
    agentId: manifest.agent.id,
  });
  // Portable heartbeat conversion produces interval jobs, including imported tasks.
  const converted = actions.flatMap(({ automation }) =>
    automation?.schedule.kind === "every"
      ? [
          {
            name: automation.name,
            enabled: automation.enabled,
            schedule: `every ${formatExactDuration(automation.schedule.everyMs)}`,
            timezone: "timezone-independent",
          },
        ]
      : [],
  );
  return [
    ...converted,
    ...manifest.automations.map((job) => ({
      name: job.name || job.id,
      enabled: job.enabled ?? true,
      schedule: job.schedule.cron,
      timezone: job.schedule.timezone,
    })),
  ];
}
