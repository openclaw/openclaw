export function buildToolSummaryMap(tools) {
    const summaries = {};
    for (const tool of tools) {
        const summary = tool.description?.trim() || tool.label?.trim();
        if (!summary) {
            continue;
        }
        summaries[tool.name.toLowerCase()] = summary;
    }
    return summaries;
}
