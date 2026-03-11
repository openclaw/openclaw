import type { BrowserWalkthroughStep, HarnessConfig, OperatorRole, SpecPacket } from "./types.js";

type TaskExecutionContract = {
  startupCommand: string;
  healthcheckUrl: string;
  browserWalkthrough: BrowserWalkthroughStep[];
};

const DEFAULT_INSTALL_COMMAND = "pnpm install --frozen-lockfile";

function stableHash(value: string) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  }
  return hash;
}

export function buildRolePort(ticketKey: string, role: OperatorRole) {
  return 41000 + (stableHash(`${ticketKey}:${role}`) % 2000);
}

function installPrefix(config: HarnessConfig) {
  const installCommand = config.workspace.installCommand?.trim() || DEFAULT_INSTALL_COMMAND;
  return `if [ ! -d node_modules ]; then ${installCommand}; fi;`;
}

function rewriteWalkthroughUrls(
  walkthrough: BrowserWalkthroughStep[],
  currentHealthcheckUrl: string,
  nextHealthcheckUrl: string,
) {
  return walkthrough.map((step) => {
    if (step.action !== "open" || !step.value || step.value !== currentHealthcheckUrl) {
      return step;
    }
    return {
      ...step,
      value: nextHealthcheckUrl,
    };
  });
}

export function buildTaskExecutionContract(input: {
  config: HarnessConfig;
  specPacket: SpecPacket;
  role: OperatorRole;
}) {
  if (input.specPacket.contractId === "moore-bass-pilot") {
    const port = buildRolePort(input.specPacket.externalTicketId, input.role);
    const startupCommand = `${installPrefix(input.config)} pnpm ui:dev --host 127.0.0.1 --port ${port}`;
    const healthcheckUrl = `http://127.0.0.1:${port}/pilot/`;
    return {
      startupCommand,
      healthcheckUrl,
      browserWalkthrough: rewriteWalkthroughUrls(
        input.specPacket.browserWalkthrough,
        input.specPacket.healthcheckUrl,
        healthcheckUrl,
      ),
    } satisfies TaskExecutionContract;
  }
  return {
    startupCommand: input.specPacket.startupCommand,
    healthcheckUrl: input.specPacket.healthcheckUrl,
    browserWalkthrough: input.specPacket.browserWalkthrough,
  } satisfies TaskExecutionContract;
}
