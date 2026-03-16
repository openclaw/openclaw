import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { loginChutes } from "./chutes-oauth.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

export async function applyAuthChoiceOAuth(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "chutes") {
    let nextConfig = params.config;
    const isRemote = isRemoteEnvironment();
    const redirectUri =
      process.env.CHUTES_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:1456/oauth-callback";
    const scopes = process.env.CHUTES_OAUTH_SCOPES?.trim() || "openid profile chutes:invoke";
    const clientId =
      process.env.CHUTES_CLIENT_ID?.trim() ||
      String(
        await params.prompter.text({
          message: "输入 Chutes OAuth Client ID",
          placeholder: "cid_xxx",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        }),
      ).trim();
    const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || undefined;

    await params.prompter.note(
      isRemote
        ? [
            "你当前运行在远程/VPS 环境中。",
            "稍后会显示一个 URL，请在你的本地浏览器中打开。",
            "登录完成后，请把重定向 URL 粘贴回这里。",
            "",
            `回调 URI：${redirectUri}`,
          ].join("\n")
        : [
            "浏览器将自动打开进行 Chutes 认证。",
            "如果回调未自动完成，请手动粘贴重定向 URL。",
            "",
            `回调 URI：${redirectUri}`,
          ].join("\n"),
      "Chutes OAuth",
    );

    const spin = params.prompter.progress("正在启动 OAuth 流程…");
    try {
      const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
        isRemote,
        prompter: params.prompter,
        runtime: params.runtime,
        spin,
        openUrl,
        localBrowserMessage: "请在浏览器中完成登录…",
      });

      const creds = await loginChutes({
        app: {
          clientId,
          clientSecret,
          redirectUri,
          scopes: scopes.split(/\s+/).filter(Boolean),
        },
        manual: isRemote,
        onAuth,
        onPrompt,
        onProgress: (msg) => spin.update(msg),
      });

      spin.stop("Chutes OAuth 已完成");
      const profileId = await writeOAuthCredentials("chutes", creds, params.agentDir);
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "chutes",
        mode: "oauth",
      });
    } catch (err) {
      spin.stop("Chutes OAuth 失败");
      params.runtime.error(String(err));
      await params.prompter.note(
        [
          "OAuth 遇到问题？",
          "请检查 CHUTES_CLIENT_ID（如果需要，也检查 CHUTES_CLIENT_SECRET）。",
          `请确认 OAuth 应用的回调 URI 包含：${redirectUri}`,
          "Chutes 文档：https://chutes.ai/docs/sign-in-with-chutes/overview",
        ].join("\n"),
        "OAuth 帮助",
      );
    }
    return { config: nextConfig };
  }

  return null;
}
