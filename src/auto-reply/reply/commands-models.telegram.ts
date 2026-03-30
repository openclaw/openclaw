type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ProviderInfo = {
  id: string;
  count: number;
};

type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
};

const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;
const CALLBACK_PREFIX = {
  providers: "mdl_prov",
  back: "mdl_back",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
} as const;

function truncateModelId(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string | null {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (Buffer.byteLength(fullCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  return Buffer.byteLength(compactCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES
    ? compactCallbackData
    : null;
}

export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];

  for (const provider of providers) {
    currentRow.push({
      text: `${provider.id} (${provider.count})`,
      callback_data: `mdl_list_${provider.id}_1`,
    });
    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);
  const currentModelId = currentModel?.includes("/")
    ? currentModel.split("/").slice(1).join("/")
    : currentModel;

  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    if (!callbackData) {
      continue;
    }
    const isCurrentModel = model === currentModelId;
    const displayLabel = modelNames?.get(`${provider}/${model}`) ?? model;
    const displayText = truncateModelId(displayLabel, 38);
    rows.push([
      {
        text: isCurrentModel ? `${displayText} ✓` : displayText,
        callback_data: callbackData,
      },
    ]);
  }

  const navRow: ButtonRow = [];
  if (currentPage > 1) {
    navRow.push({
      text: "Previous",
      callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage - 1}`,
    });
  }
  if (currentPage < totalPages) {
    navRow.push({
      text: "Next",
      callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage + 1}`,
    });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.providers }]);
  return rows;
}

export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

export function calculateTotalPages(totalModels: number, pageSize = MODELS_PAGE_SIZE): number {
  if (totalModels <= 0) {
    return 0;
  }
  return Math.ceil(totalModels / pageSize);
}
