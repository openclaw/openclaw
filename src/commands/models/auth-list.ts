import type { RuntimeEnv } from "../../runtime.js";
import { renderTable } from "../../terminal/table.js";
import { colorize, theme } from "../../terminal/theme.js";
import { modelsAuthListLogic } from "./auth-list.logic.js";
import { formatProfileStatus, isRich } from "./list.format.js";
import { ensureFlagCompatibility } from "./shared.js";

export async function modelsAuthListCommand(
  opts: {
    provider?: string;
    json?: boolean;
    plain?: boolean;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);

  const {
    agentId,
    agentDir,
    authStorePath,
    profiles: allInfos,
  } = await modelsAuthListLogic({
    provider: opts.provider,
    agent: opts.agent,
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...(agentId ? { agentId } : {}),
          agentDir,
          authStorePath,
          profiles: allInfos.map((info) => ({
            profileId: info.profileId,
            provider: info.provider,
            type: info.type,
            status: info.status,
            active: info.active,
            ...(info.email ? { email: info.email } : {}),
            ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
            ...(info.remainingMs !== undefined ? { remainingMs: info.remainingMs } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.plain) {
    for (const info of allInfos) {
      runtime.log(`${info.profileId}\t${info.provider}\t${info.type}\t${info.status}`);
    }
    return;
  }

  const rich = isRich(opts);

  runtime.log(
    `${colorize(rich, theme.heading, `Auth profiles (${allInfos.length})`)}  ${colorize(rich, theme.muted, `Store: ${authStorePath}`)}`,
  );

  if (allInfos.length === 0) {
    runtime.log(colorize(rich, theme.muted, "  (no profiles)"));
    return;
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = allInfos.map((info) => {
    const activeMarker = info.active ? colorize(rich, theme.success, "*") : " ";
    return {
      Profile: `${colorize(rich, theme.accent, info.profileId)} ${activeMarker}`,
      Type: colorize(rich, theme.info, info.type),
      Provider: colorize(rich, theme.heading, info.provider),
      Status: formatProfileStatus(info.status, rich),
      Detail: info.detail
        ? colorize(rich, theme.muted, info.detail)
        : colorize(rich, theme.muted, "-"),
    };
  });

  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Profile", header: "Profile", minWidth: 20 },
        { key: "Type", header: "Type", minWidth: 8 },
        { key: "Provider", header: "Provider", minWidth: 12 },
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Detail", header: "Detail", minWidth: 12, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
}
