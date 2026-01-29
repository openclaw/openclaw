/**
 * i18n type definitions for Control UI
 */

export type Locale = 'en' | 'zh-CN';

export interface TranslationKeys {
  // Navigation groups
  'nav.chat': string;
  'nav.control': string;
  'nav.agent': string;
  'nav.settings': string;

  // Tab titles
  'tab.overview': string;
  'tab.channels': string;
  'tab.instances': string;
  'tab.sessions': string;
  'tab.cron': string;
  'tab.skills': string;
  'tab.nodes': string;
  'tab.chat': string;
  'tab.config': string;
  'tab.debug': string;
  'tab.logs': string;

  // Tab subtitles/descriptions
  'tab.overview.desc': string;
  'tab.channels.desc': string;
  'tab.instances.desc': string;
  'tab.sessions.desc': string;
  'tab.cron.desc': string;
  'tab.skills.desc': string;
  'tab.nodes.desc': string;
  'tab.chat.desc': string;
  'tab.config.desc': string;
  'tab.debug.desc': string;
  'tab.logs.desc': string;

  // Common actions
  'action.save': string;
  'action.cancel': string;
  'action.apply': string;
  'action.reset': string;
  'action.delete': string;
  'action.edit': string;
  'action.add': string;
  'action.remove': string;
  'action.refresh': string;
  'action.copy': string;
  'action.close': string;
  'action.confirm': string;
  'action.send': string;
  'action.stop': string;
  'action.retry': string;

  // Status
  'status.online': string;
  'status.offline': string;
  'status.connected': string;
  'status.disconnected': string;
  'status.loading': string;
  'status.error': string;
  'status.success': string;
  'status.pending': string;
  'status.idle': string;
  'status.running': string;
  'status.ok': string;

  // Header
  'header.health': string;
  'header.brand.title': string;
  'header.brand.sub': string;
  'header.expandSidebar': string;
  'header.collapseSidebar': string;

  // Theme
  'theme.light': string;
  'theme.dark': string;
  'theme.system': string;

  // Chat
  'chat.placeholder': string;
  'chat.send': string;
  'chat.thinking': string;
  'chat.attachFile': string;
  'chat.clearHistory': string;

  // Channels
  'channels.whatsapp': string;
  'channels.telegram': string;
  'channels.discord': string;
  'channels.slack': string;
  'channels.signal': string;
  'channels.imessage': string;
  'channels.nostr': string;
  'channels.googlechat': string;

  // Sessions
  'sessions.title': string;
  'sessions.active': string;
  'sessions.tokens': string;
  'sessions.model': string;
  'sessions.lastActivity': string;

  // Cron
  'cron.title': string;
  'cron.schedule': string;
  'cron.nextRun': string;
  'cron.lastRun': string;
  'cron.enabled': string;
  'cron.disabled': string;
  'cron.addJob': string;

  // Config
  'config.title': string;
  'config.saved': string;
  'config.unsaved': string;
  'config.saveChanges': string;
  'config.discardChanges': string;

  // Logs
  'logs.title': string;
  'logs.level': string;
  'logs.filter': string;
  'logs.export': string;
  'logs.clear': string;

  // Skills
  'skills.title': string;
  'skills.installed': string;
  'skills.available': string;
  'skills.install': string;
  'skills.uninstall': string;

  // Nodes
  'nodes.title': string;
  'nodes.paired': string;
  'nodes.pending': string;
  'nodes.approve': string;
  'nodes.reject': string;

  // Errors
  'error.connection': string;
  'error.timeout': string;
  'error.unknown': string;
  'error.invalidInput': string;

  // Misc
  'misc.noData': string;
  'misc.loading': string;
  'misc.never': string;
  'misc.justNow': string;
  'misc.ago': string;
}

export type TranslationKey = keyof TranslationKeys;
