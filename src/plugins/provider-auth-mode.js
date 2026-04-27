export async function resolveSecretInputModeForEnvSelection(params) {
    if (params.explicitMode) {
        return params.explicitMode;
    }
    if (typeof params.prompter.select !== "function") {
        return "plaintext";
    }
    const selected = await params.prompter.select({
        message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
        initialValue: "plaintext",
        options: [
            {
                value: "plaintext",
                label: params.copy?.plaintextLabel ?? "Paste API key now",
                hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config",
            },
            {
                value: "ref",
                label: params.copy?.refLabel ?? "Use external secret provider",
                hint: params.copy?.refHint ??
                    "Stores a reference to env or configured external secret providers",
            },
        ],
    });
    return selected === "ref" ? "ref" : "plaintext";
}
