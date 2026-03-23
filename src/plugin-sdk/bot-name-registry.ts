// Public surface for channel providers to register/unregister bot display names
// so that the hook runner can inject bot_name into every hook event.

export {
  registerBotName,
  unregisterBotName,
  getBotName,
  resolveBotName,
} from "../plugins/bot-name-registry.js";
