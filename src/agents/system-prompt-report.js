import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
function extractBetween(input, startMarker, endMarker) {
    const start = input.indexOf(startMarker);
    if (start === -1) {
        return { text: "", found: false };
    }
    const end = input.indexOf(endMarker, start + startMarker.length);
    if (end === -1) {
        return { text: input.slice(start), found: true };
    }
    return { text: input.slice(start, end), found: true };
}
function parseSkillBlocks(skillsPrompt) {
    const prompt = skillsPrompt.trim();
    if (!prompt) {
        return [];
    }
    const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map((match) => match[0] ?? "");
    return blocks
        .map((block) => {
        const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
        return { name, blockChars: block.length };
    })
        .filter((b) => b.blockChars > 0);
}
function buildToolsEntries(tools) {
    return tools.map((tool) => {
        const name = tool.name;
        const summary = tool.description?.trim() || tool.label?.trim() || "";
        const summaryChars = summary.length;
        const schemaChars = (() => {
            if (!tool.parameters || typeof tool.parameters !== "object") {
                return 0;
            }
            try {
                return JSON.stringify(tool.parameters).length;
            }
            catch {
                return 0;
            }
        })();
        const propertiesCount = (() => {
            const schema = tool.parameters && typeof tool.parameters === "object"
                ? tool.parameters
                : null;
            const props = schema && typeof schema.properties === "object" ? schema.properties : null;
            if (!props || typeof props !== "object") {
                return null;
            }
            return Object.keys(props).length;
        })();
        return { name, summaryChars, schemaChars, propertiesCount };
    });
}
export function buildSystemPromptReport(params) {
    const systemPrompt = params.systemPrompt.trim();
    const projectContext = extractBetween(systemPrompt, "\n# Project Context\n", "\n## Silent Replies\n");
    const projectContextChars = projectContext.text.length;
    const toolsEntries = buildToolsEntries(params.tools);
    const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
    const skillsEntries = parseSkillBlocks(params.skillsPrompt);
    return {
        source: params.source,
        generatedAt: params.generatedAt,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        model: params.model,
        workspaceDir: params.workspaceDir,
        bootstrapMaxChars: params.bootstrapMaxChars,
        bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
        ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
        sandbox: params.sandbox,
        systemPrompt: {
            chars: systemPrompt.length,
            projectContextChars,
            nonProjectContextChars: Math.max(0, systemPrompt.length - projectContextChars),
        },
        injectedWorkspaceFiles: buildBootstrapInjectionStats({
            bootstrapFiles: params.bootstrapFiles,
            injectedFiles: params.injectedFiles,
        }),
        skills: {
            promptChars: params.skillsPrompt.length,
            entries: skillsEntries,
        },
        tools: {
            listChars: 0,
            schemaChars: toolsSchemaChars,
            entries: toolsEntries,
        },
    };
}
