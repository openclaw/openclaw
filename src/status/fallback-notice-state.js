import { normalizeOptionalString } from "../shared/string-coerce.js";
export function resolveActiveFallbackState(params) {
    const selected = normalizeOptionalString(params.state?.fallbackNoticeSelectedModel);
    const active = normalizeOptionalString(params.state?.fallbackNoticeActiveModel);
    const reason = normalizeOptionalString(params.state?.fallbackNoticeReason);
    const fallbackActive = params.selectedModelRef !== params.activeModelRef &&
        selected === params.selectedModelRef &&
        active === params.activeModelRef;
    return {
        active: fallbackActive,
        reason: fallbackActive ? reason : undefined,
    };
}
