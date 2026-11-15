import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveManifestActivationPluginIds } from "../../plugins/activation-planner.js";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import { createWorkerBrowserToolDefinition } from "../../worker/browser-runtime.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";

export async function prepareWorkerDesktopLaunchPlan(params: {
  desktop: WorkerDesktopEndpoint | null;
  protocolFeatures: readonly string[];
  prepareComputer(): Promise<PreparedWorkerComputer | undefined> | undefined;
  turn: SessionPlacementTurnParams;
}) {
  const computerSupported =
    params.turn.modelHasVision !== false &&
    params.protocolFeatures.includes(WORKER_COMPUTER_PROTOCOL_FEATURE);
  const preparedComputer = computerSupported ? await params.prepareComputer() : undefined;
  const browserApp = params.desktop?.apps?.find((app) => app.id === "browser");
  const browserAvailable =
    browserApp !== undefined &&
    params.turn.config?.browser?.enabled !== false &&
    resolveManifestActivationPluginIds({
      trigger: { kind: "capability", capability: "tool" },
      config: params.turn.config,
      onlyPluginIds: ["browser"],
    }).includes("browser");
  const computer = preparedComputer?.descriptor;
  const browser = browserAvailable
    ? {
        cdpUrl: `http://127.0.0.1:${browserApp.cdpPort}`,
        launcherPath: browserApp.executablePath,
        ...(browserApp.args ? { launcherArgs: [...browserApp.args] } : {}),
      }
    : undefined;
  const placementOnly = async (): Promise<never> => {
    throw new Error("This tool executes at the placement");
  };
  const tools: AnyAgentTool[] = browser
    ? [{ ...createWorkerBrowserToolDefinition(browser), execute: placementOnly }]
    : [];
  if (computer) {
    tools.push(
      createWorkerComputerTool({
        descriptor: computer,
        requestComputer: placementOnly,
        runId: params.turn.runId,
        registerRunCleanup: () => undefined,
      }),
    );
  }
  return { computer, preparedComputer, browser, tools };
}
