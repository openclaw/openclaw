/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model
 * - mdl_back              - back to providers list
 */
const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;
/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export function parseModelCallbackData(data) {
    const trimmed = data.trim();
    if (!trimmed.startsWith("mdl_")) {
        return null;
    }
    if (trimmed === "mdl_prov" || trimmed === "mdl_back") {
        return { type: trimmed === "mdl_prov" ? "providers" : "back" };
    }
    // mdl_list_{provider}_{page}
    const listMatch = trimmed.match(/^mdl_list_([a-z0-9_-]+)_(\d+)$/i);
    if (listMatch) {
        const [, provider, pageStr] = listMatch;
        const page = Number.parseInt(pageStr ?? "1", 10);
        if (provider && Number.isFinite(page) && page >= 1) {
            return { type: "list", provider, page };
        }
    }
    // mdl_sel_{provider/model}
    const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
    if (selMatch) {
        const modelRef = selMatch[1];
        if (modelRef) {
            const slashIndex = modelRef.indexOf("/");
            if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
                return {
                    type: "select",
                    provider: modelRef.slice(0, slashIndex),
                    model: modelRef.slice(slashIndex + 1),
                };
            }
        }
    }
    return null;
}
/**
 * Build provider selection keyboard with 2 providers per row.
 */
export function buildProviderKeyboard(providers) {
    if (providers.length === 0) {
        return [];
    }
    const rows = [];
    let currentRow = [];
    for (const provider of providers) {
        const button = {
            text: `${provider.id} (${provider.count})`,
            callback_data: `mdl_list_${provider.id}_1`,
        };
        currentRow.push(button);
        if (currentRow.length === 2) {
            rows.push(currentRow);
            currentRow = [];
        }
    }
    // Push any remaining button
    if (currentRow.length > 0) {
        rows.push(currentRow);
    }
    return rows;
}
/**
 * Build model list keyboard with pagination and back button.
 */
export function buildModelsKeyboard(params) {
    const { provider, models, currentModel, currentPage, totalPages } = params;
    const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;
    if (models.length === 0) {
        return [[{ text: "<< Back", callback_data: "mdl_back" }]];
    }
    const rows = [];
    // Calculate page slice
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, models.length);
    const pageModels = models.slice(startIndex, endIndex);
    // Model buttons - one per row
    const currentModelId = currentModel?.includes("/")
        ? currentModel.split("/").slice(1).join("/")
        : currentModel;
    for (const model of pageModels) {
        const callbackData = `mdl_sel_${provider}/${model}`;
        // Skip models that would exceed Telegram's callback_data limit
        if (Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES) {
            continue;
        }
        const isCurrentModel = model === currentModelId;
        const displayText = truncateModelId(model, 38);
        const text = isCurrentModel ? `${displayText} ✓` : displayText;
        rows.push([
            {
                text,
                callback_data: callbackData,
            },
        ]);
    }
    // Pagination row
    if (totalPages > 1) {
        const paginationRow = [];
        if (currentPage > 1) {
            paginationRow.push({
                text: "◀ Prev",
                callback_data: `mdl_list_${provider}_${currentPage - 1}`,
            });
        }
        paginationRow.push({
            text: `${currentPage}/${totalPages}`,
            callback_data: `mdl_list_${provider}_${currentPage}`, // noop
        });
        if (currentPage < totalPages) {
            paginationRow.push({
                text: "Next ▶",
                callback_data: `mdl_list_${provider}_${currentPage + 1}`,
            });
        }
        rows.push(paginationRow);
    }
    // Back button
    rows.push([{ text: "<< Back", callback_data: "mdl_back" }]);
    return rows;
}
/**
 * Build "Browse providers" button for /model summary.
 */
export function buildBrowseProvidersButton() {
    return [[{ text: "Browse providers", callback_data: "mdl_prov" }]];
}
/**
 * Truncate model ID for display, preserving end if too long.
 */
function truncateModelId(modelId, maxLen) {
    if (modelId.length <= maxLen) {
        return modelId;
    }
    // Show last part with ellipsis prefix
    return `…${modelId.slice(-(maxLen - 1))}`;
}
/**
 * Get page size for model list pagination.
 */
export function getModelsPageSize() {
    return MODELS_PAGE_SIZE;
}
/**
 * Calculate total pages for a model list.
 */
export function calculateTotalPages(totalModels, pageSize) {
    const size = pageSize ?? MODELS_PAGE_SIZE;
    return size > 0 ? Math.ceil(totalModels / size) : 1;
}
