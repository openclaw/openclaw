/**
 * English translations
 */

export default {
  // App
  "app.title": "OpenClaw Setup",
  "app.subtitle": "Configure your AI assistant",
  "app.loading": "Loading...",
  "app.connecting": "Connecting to server...",
  "app.connection_error": "Connection failed. Please refresh the page.",

  // Language
  "lang.en": "English",
  "lang.zh": "中文",

  // Common
  "common.next": "Next",
  "common.back": "Back",
  "common.skip": "Skip",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.yes": "Yes",
  "common.no": "No",
  "common.done": "Done",
  "common.close": "Close",
  "common.select": "Select",
  "common.continue": "Continue",
  "common.or": "or",

  // Welcome
  "welcome.title": "Welcome to OpenClaw",
  "welcome.subtitle": "Let's set up your AI assistant",
  "welcome.description": "This wizard will help you configure OpenClaw step by step.",
  "welcome.start": "Get Started",

  // Security
  "security.title": "Security Notice",
  "security.warning": "Security warning — please read carefully.",
  "security.description": `OpenClaw is a powerful AI assistant that can:
• Read files and access your filesystem
• Execute commands if tools are enabled
• Respond to messages from configured channels

Please ensure you understand the security implications before proceeding.`,
  "security.recommendations": `Recommended security measures:
• Use pairing/allowlists and mention gating
• Enable sandbox and least-privilege tools
• Keep secrets out of the agent's reachable filesystem
• Use the strongest available model for bots with tools`,
  "security.docs": "Read security documentation",
  "security.accept": "I understand the risks and want to continue",
  "security.decline": "I need more time to review",

  // Auth Provider
  "auth.title": "Model Provider",
  "auth.subtitle": "Select your AI model provider",
  "auth.description": "Choose how you want to authenticate with AI model providers.",
  
  // Provider groups
  "auth.group.anthropic": "Anthropic",
  "auth.group.openai": "OpenAI",
  "auth.group.google": "Google",
  "auth.group.chinese": "Chinese Providers",
  "auth.group.aggregator": "Aggregators",
  "auth.group.other": "Other",

  // Provider options
  "auth.anthropic": "Anthropic (Claude)",
  "auth.openai": "OpenAI (GPT)",
  "auth.google": "Google (Gemini)",
  "auth.openrouter": "OpenRouter",
  "auth.siliconflow": "SiliconFlow (硅基流动)",
  "auth.opencode": "OpenCode Zen",
  "auth.nvidia": "NVIDIA NIM",
  "auth.moonshot": "Moonshot (Kimi)",
  "auth.minimax": "MiniMax",
  "auth.zai": "Z.AI (GLM)",
  "auth.xiaomi": "Xiaomi (MiMo)",
  "auth.venice": "Venice AI",
  "auth.synthetic": "Synthetic",
  "auth.copilot": "GitHub Copilot",

  // API Key
  "auth.api_key.title": "API Key",
  "auth.api_key.label": "Enter your API key",
  "auth.api_key.placeholder": "sk-...",
  "auth.api_key.hint": "Your API key will be stored securely on your local machine.",
  "auth.api_key.get_key": "Get API key",
  "auth.api_key.invalid": "Please enter a valid API key",

  // Model Selection
  "model.title": "Default Model",
  "model.subtitle": "Select your default AI model",
  "model.description": "This model will be used by default for conversations.",
  "model.filter": "Filter by provider",
  "model.search": "Search models...",
  "model.free": "Free",
  "model.paid": "Paid",
  "model.reasoning": "Reasoning",

  // Gateway
  "gateway.title": "Gateway Settings",
  "gateway.subtitle": "Configure the OpenClaw gateway",
  "gateway.description": "The gateway handles communication between your channels and the AI.",
  "gateway.port": "Port",
  "gateway.port_hint": "Default: 18789",
  "gateway.bind": "Bind Mode",
  "gateway.bind.loopback": "Loopback (127.0.0.1) - Local only",
  "gateway.bind.lan": "LAN (0.0.0.0) - All interfaces",
  "gateway.bind.tailnet": "Tailnet - Tailscale network",
  "gateway.bind.auto": "Auto - Prefer loopback",
  "gateway.auth": "Authentication",
  "gateway.auth.token": "Token",
  "gateway.auth.password": "Password",
  "gateway.token": "Gateway Token",
  "gateway.token_hint": "Leave empty to auto-generate",

  // Channels
  "channels.title": "Channels",
  "channels.subtitle": "Configure messaging channels",
  "channels.description": "Select which messaging platforms you want to connect to OpenClaw.",
  "channels.telegram": "Telegram",
  "channels.discord": "Discord",
  "channels.whatsapp": "WhatsApp",
  "channels.slack": "Slack",
  "channels.signal": "Signal",
  "channels.imessage": "iMessage",
  "channels.configured": "Configured",
  "channels.not_configured": "Not configured",
  "channels.skip": "Skip channel setup",

  // Skills
  "skills.title": "Skills",
  "skills.subtitle": "Configure agent skills",
  "skills.description": "Skills extend your agent's capabilities with additional tools.",
  "skills.eligible": "Available skills",
  "skills.missing_deps": "Missing dependencies",
  "skills.install_deps": "Install dependencies",
  "skills.skip": "Skip skill setup",

  // Hooks
  "hooks.title": "Hooks",
  "hooks.subtitle": "Configure automation hooks",
  "hooks.description": "Hooks let you automate actions when agent commands are issued.",
  "hooks.no_hooks": "No hooks available. You can configure hooks later in your config.",
  "hooks.skip": "Skip hook setup",

  // Complete
  "complete.title": "Setup Complete!",
  "complete.subtitle": "OpenClaw is ready to use",
  "complete.description": "Your configuration has been saved. You can now start using OpenClaw.",
  "complete.next_steps": "Next steps:",
  "complete.step1": "Ensure the gateway is running (see above)",
  "complete.step2": "Access the dashboard at: http://127.0.0.1:18789",
  "complete.step3": "Send a message through your configured channel",
  "complete.open_dashboard": "Open Dashboard",
  "complete.close": "Close Setup",
  "complete.gateway_info_title": "Starting the Gateway",
  "complete.gateway_info_desc": "If the gateway service was not installed successfully (e.g., due to permission issues), you need to start it manually:",
  "complete.gateway_info_note": "Keep this terminal open while using OpenClaw. The gateway handles communication between your channels and the AI.",
  "complete.service_warning_title": "Windows Users Note",
  "complete.service_warning_desc": "If the gateway service installation failed due to 'Access Denied', you can either run the onboarding as Administrator, or simply run 'openclaw gateway run' each time you want to use OpenClaw.",
  "complete.shutdown_description": "When you're done, you can close this wizard and stop the onboarding server:",
  "complete.shutdown_wizard": "Close Wizard & Stop Server",
  "complete.shutting_down": "Shutting down...",
  "complete.shutdown_complete": "Server stopped",
  "complete.shutdown_status": "The onboarding server has been stopped. You can close this tab.",

  // Progress
  "progress.step": "Step",
  "progress.of": "of",

  // Errors
  "error.title": "Error",
  "error.connection_lost": "Connection to server lost",
  "error.retry": "Retry",
  "error.unknown": "An unknown error occurred",

  // Cancelled
  "cancelled.title": "Setup Cancelled",
  "cancelled.risk_not_accepted": "You chose not to continue. You can restart the setup when you're ready.",
  "cancelled.default": "Setup was cancelled. You can restart anytime.",

  // Backend message translations (for known messages)
  "backend.risk_not_accepted": "You chose not to continue. You can restart the setup when you're ready.",
  "backend.wizard_cancelled": "Setup was cancelled.",

  // Wizard-specific messages
  "wizard.confirm_risk": "I understand this is powerful and inherently risky. Continue?",
  "wizard.enter_anthropic_key": "Enter your Anthropic API key",
  "wizard.enter_openai_key": "Enter your OpenAI API key",
  "wizard.enter_google_key": "Enter your Google API key",
  "wizard.enter_openrouter_key": "Enter your OpenRouter API key",
  "wizard.enter_siliconflow_key": "Enter your SiliconFlow API key",
  "wizard.enter_opencode_key": "Enter your OpenCode Zen API key",
  "wizard.enter_nvidia_key": "Enter your NVIDIA NIM API key",
  "wizard.install_gateway": "Install gateway as system service?",
  "wizard.gateway_install_failed": "Gateway service installation failed. Administrator privileges may be required.",
  "wizard.config_saved": "Configuration saved successfully!",
  "wizard.fetching_models": "Fetching available models...",
  "wizard.validating_key": "Validating API key...",
  "wizard.saving_config": "Saving configuration...",
};
