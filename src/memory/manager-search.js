import { truncateUtf16Safe } from "../utils.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
const vectorToBlob = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
export async function searchVector(params) {
    if (params.queryVec.length === 0 || params.limit <= 0) {
        return [];
    }
    if (await params.ensureVectorReady(params.queryVec.length)) {
        const rows = params.db
            .prepare(`SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
            `       c.source,\n` +
            `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
            `  FROM ${params.vectorTable} v\n` +
            `  JOIN chunks c ON c.id = v.id\n` +
            ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
            ` ORDER BY dist ASC\n` +
            ` LIMIT ?`)
            .all(vectorToBlob(params.queryVec), params.providerModel, ...params.sourceFilterVec.params, params.limit);
        return rows.map((row) => ({
            id: row.id,
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: 1 - row.dist,
            snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
            source: row.source,
        }));
    }
    const candidates = listChunks({
        db: params.db,
        providerModel: params.providerModel,
        sourceFilter: params.sourceFilterChunks,
    });
    const scored = candidates
        .map((chunk) => ({
        chunk,
        score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
        .filter((entry) => Number.isFinite(entry.score));
    return scored
        .toSorted((a, b) => b.score - a.score)
        .slice(0, params.limit)
        .map((entry) => ({
        id: entry.chunk.id,
        path: entry.chunk.path,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        score: entry.score,
        snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
        source: entry.chunk.source,
    }));
}
export function listChunks(params) {
    const rows = params.db
        .prepare(`SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`)
        .all(params.providerModel, ...params.sourceFilter.params);
    return rows.map((row) => ({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        embedding: parseEmbedding(row.embedding),
        source: row.source,
    }));
}
export async function searchKeyword(params) {
    if (params.limit <= 0) {
        return [];
    }
    const ftsQuery = params.buildFtsQuery(params.query);
    if (!ftsQuery) {
        return [];
    }
    // When providerModel is undefined (FTS-only mode), search all models
    const modelClause = params.providerModel ? " AND model = ?" : "";
    const modelParams = params.providerModel ? [params.providerModel] : [];
    const rows = params.db
        .prepare(`SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`)
        .all(ftsQuery, ...modelParams, ...params.sourceFilter.params, params.limit);
    return rows.map((row) => {
        const textScore = params.bm25RankToScore(row.rank);
        return {
            id: row.id,
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: textScore,
            textScore,
            snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
            source: row.source,
        };
    });
}
