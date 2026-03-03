import { postJson } from "./post-json.js";
export async function fetchRemoteEmbeddingVectors(params) {
    return await postJson({
        url: params.url,
        headers: params.headers,
        ssrfPolicy: params.ssrfPolicy,
        body: params.body,
        errorPrefix: params.errorPrefix,
        parse: (payload) => {
            const typedPayload = payload;
            const data = typedPayload.data ?? [];
            return data.map((entry) => entry.embedding ?? []);
        },
    });
}
