import { resolvePluginWebContentExtractors } from "../plugins/web-content-extractors.runtime.js";
let extractorPromise;
const extractorPromisesByConfig = new WeakMap();
async function loadWebContentExtractors(config) {
    if (config) {
        const cached = extractorPromisesByConfig.get(config);
        if (cached) {
            return await cached;
        }
        const promise = Promise.resolve().then(() => resolvePluginWebContentExtractors({ config }));
        extractorPromisesByConfig.set(config, promise);
        void promise.catch(() => {
            extractorPromisesByConfig.delete(config);
        });
        return await promise;
    }
    extractorPromise ??= Promise.resolve(resolvePluginWebContentExtractors());
    return await extractorPromise;
}
export async function extractReadableContent(params) {
    let extractors;
    try {
        extractors = await loadWebContentExtractors(params.config);
    }
    catch {
        return null;
    }
    for (const extractor of extractors) {
        let result;
        try {
            result = await extractor.extract({
                html: params.html,
                url: params.url,
                extractMode: params.extractMode,
            });
        }
        catch {
            continue;
        }
        if (result?.text) {
            return {
                ...result,
                extractor: extractor.id,
            };
        }
    }
    return null;
}
