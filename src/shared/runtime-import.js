export async function importRuntimeModule(baseUrl, parts) {
    return (await import(new URL(parts.join(""), baseUrl).href));
}
