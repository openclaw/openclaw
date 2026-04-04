import { getBundledChannelContractSurfaceModule } from "../channels/plugins/contract-surfaces.js";

type TelegramCommandUiContract = {
  buildCommandsPaginationKeyboard: (
    currentPage: number,
    totalPages: number,
    agentId?: string,
  ) => Array<Array<{ text: string; callback_data: string }>>;
};

function loadTelegramCommandUiContract(): TelegramCommandUiContract {
  const contract = getBundledChannelContractSurfaceModule<TelegramCommandUiContract>({
    pluginId: "telegram",
    preferredBasename: "contract-api.ts",
  });
  if (!contract) {
    throw new Error("telegram command ui contract surface is unavailable");
  }
  return contract;
}

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return loadTelegramCommandUiContract().buildCommandsPaginationKeyboard(
    currentPage,
    totalPages,
    agentId,
  );
}
