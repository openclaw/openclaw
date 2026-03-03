const validateRequiredInput = (value) => (value.trim().length > 0 ? undefined : "Required");
export function createVpsAwareOAuthHandlers(params) {
    const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
    let manualCodePromise;
    return {
        onAuth: async ({ url }) => {
            if (params.isRemote) {
                params.spin.stop("OAuth URL ready");
                params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
                manualCodePromise = params.prompter
                    .text({
                    message: manualPromptMessage,
                    validate: validateRequiredInput,
                })
                    .then((value) => String(value));
                return;
            }
            params.spin.update(params.localBrowserMessage);
            await params.openUrl(url);
            params.runtime.log(`Open: ${url}`);
        },
        onPrompt: async (prompt) => {
            if (manualCodePromise) {
                return manualCodePromise;
            }
            const code = await params.prompter.text({
                message: prompt.message,
                placeholder: prompt.placeholder,
                validate: validateRequiredInput,
            });
            return String(code);
        },
    };
}
