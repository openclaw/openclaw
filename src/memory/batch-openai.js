import { applyEmbeddingBatchOutputLine, buildBatchHeaders, buildEmbeddingBatchGroupOptions, EMBEDDING_BATCH_ENDPOINT, extractBatchErrorMessage, formatUnavailableBatchError, normalizeBatchBaseUrl, postJsonWithRetry, runEmbeddingBatchGroups, uploadBatchJsonlFile, withRemoteHttpResponse, } from "./batch-embedding-common.js";
export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50000;
async function submitOpenAiBatch(params) {
    const baseUrl = normalizeBatchBaseUrl(params.openAi);
    const inputFileId = await uploadBatchJsonlFile({
        client: params.openAi,
        requests: params.requests,
        errorPrefix: "openai batch file upload failed",
    });
    return await postJsonWithRetry({
        url: `${baseUrl}/batches`,
        headers: buildBatchHeaders(params.openAi, { json: true }),
        ssrfPolicy: params.openAi.ssrfPolicy,
        body: {
            input_file_id: inputFileId,
            endpoint: OPENAI_BATCH_ENDPOINT,
            completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
            metadata: {
                source: "openclaw-memory",
                agent: params.agentId,
            },
        },
        errorPrefix: "openai batch create failed",
    });
}
async function fetchOpenAiBatchStatus(params) {
    const baseUrl = normalizeBatchBaseUrl(params.openAi);
    return await withRemoteHttpResponse({
        url: `${baseUrl}/batches/${params.batchId}`,
        ssrfPolicy: params.openAi.ssrfPolicy,
        init: {
            headers: buildBatchHeaders(params.openAi, { json: true }),
        },
        onResponse: async (res) => {
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`openai batch status failed: ${res.status} ${text}`);
            }
            return (await res.json());
        },
    });
}
async function fetchOpenAiFileContent(params) {
    const baseUrl = normalizeBatchBaseUrl(params.openAi);
    return await withRemoteHttpResponse({
        url: `${baseUrl}/files/${params.fileId}/content`,
        ssrfPolicy: params.openAi.ssrfPolicy,
        init: {
            headers: buildBatchHeaders(params.openAi, { json: true }),
        },
        onResponse: async (res) => {
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`openai batch file content failed: ${res.status} ${text}`);
            }
            return await res.text();
        },
    });
}
function parseOpenAiBatchOutput(text) {
    if (!text.trim()) {
        return [];
    }
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
async function readOpenAiBatchError(params) {
    try {
        const content = await fetchOpenAiFileContent({
            openAi: params.openAi,
            fileId: params.errorFileId,
        });
        const lines = parseOpenAiBatchOutput(content);
        return extractBatchErrorMessage(lines);
    }
    catch (err) {
        return formatUnavailableBatchError(err);
    }
}
async function waitForOpenAiBatch(params) {
    const start = Date.now();
    let current = params.initial;
    while (true) {
        const status = current ??
            (await fetchOpenAiBatchStatus({
                openAi: params.openAi,
                batchId: params.batchId,
            }));
        const state = status.status ?? "unknown";
        if (state === "completed") {
            if (!status.output_file_id) {
                throw new Error(`openai batch ${params.batchId} completed without output file`);
            }
            return {
                outputFileId: status.output_file_id,
                errorFileId: status.error_file_id ?? undefined,
            };
        }
        if (["failed", "expired", "cancelled", "canceled"].includes(state)) {
            const detail = status.error_file_id
                ? await readOpenAiBatchError({ openAi: params.openAi, errorFileId: status.error_file_id })
                : undefined;
            const suffix = detail ? `: ${detail}` : "";
            throw new Error(`openai batch ${params.batchId} ${state}${suffix}`);
        }
        if (!params.wait) {
            throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
        }
        if (Date.now() - start > params.timeoutMs) {
            throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
        }
        params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
        current = undefined;
    }
}
export async function runOpenAiEmbeddingBatches(params) {
    return await runEmbeddingBatchGroups({
        ...buildEmbeddingBatchGroupOptions(params, {
            maxRequests: OPENAI_BATCH_MAX_REQUESTS,
            debugLabel: "memory embeddings: openai batch submit",
        }),
        runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
            const batchInfo = await submitOpenAiBatch({
                openAi: params.openAi,
                requests: group,
                agentId: params.agentId,
            });
            if (!batchInfo.id) {
                throw new Error("openai batch create failed: missing batch id");
            }
            params.debug?.("memory embeddings: openai batch created", {
                batchId: batchInfo.id,
                status: batchInfo.status,
                group: groupIndex + 1,
                groups,
                requests: group.length,
            });
            if (!params.wait && batchInfo.status !== "completed") {
                throw new Error(`openai batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`);
            }
            const completed = batchInfo.status === "completed"
                ? {
                    outputFileId: batchInfo.output_file_id ?? "",
                    errorFileId: batchInfo.error_file_id ?? undefined,
                }
                : await waitForOpenAiBatch({
                    openAi: params.openAi,
                    batchId: batchInfo.id,
                    wait: params.wait,
                    pollIntervalMs: params.pollIntervalMs,
                    timeoutMs: params.timeoutMs,
                    debug: params.debug,
                    initial: batchInfo,
                });
            if (!completed.outputFileId) {
                throw new Error(`openai batch ${batchInfo.id} completed without output file`);
            }
            const content = await fetchOpenAiFileContent({
                openAi: params.openAi,
                fileId: completed.outputFileId,
            });
            const outputLines = parseOpenAiBatchOutput(content);
            const errors = [];
            const remaining = new Set(group.map((request) => request.custom_id));
            for (const line of outputLines) {
                applyEmbeddingBatchOutputLine({ line, remaining, errors, byCustomId });
            }
            if (errors.length > 0) {
                throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
            }
            if (remaining.size > 0) {
                throw new Error(`openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
            }
        },
    });
}
