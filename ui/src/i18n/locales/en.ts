import type { TranslationKeys } from '../types';

export const en: TranslationKeys = {
  // Navigation groups
  'nav.chat': 'Chat',
  'nav.control': 'Control',
  'nav.agent': 'Agent',
  'nav.settings': 'Settings',

  // Tab titles
  'tab.overview': 'Overview',
  'tab.channels': 'Channels',
  'tab.instances': 'Instances',
  'tab.sessions': 'Sessions',
  'tab.cron': 'Cron Jobs',
  'tab.skills': 'Skills',
  'tab.nodes': 'Nodes',
  'tab.chat': 'Chat',
  'tab.config': 'Config',
  'tab.debug': 'Debug',
  'tab.logs': 'Logs',

  // Tab subtitles/descriptions
  'tab.overview.desc': 'Gateway status, entry points, and a fast health read.',
  'tab.channels.desc': 'Manage channels and settings.',
  'tab.instances.desc': 'Presence beacons from connected clients and nodes.',
  'tab.sessions.desc': 'Inspect active sessions and adjust per-session defaults.',
  'tab.cron.desc': 'Schedule wakeups and recurring agent runs.',
  'tab.skills.desc': 'Manage skill availability and API key injection.',
  'tab.nodes.desc': 'Paired devices, capabilities, and command exposure.',
  'tab.chat.desc': 'Direct gateway chat session for quick interventions.',
  'tab.config.desc': 'Edit ~/.clawdbot/clawdbot.json safely.',
  'tab.debug.desc': 'Gateway snapshots, events, and manual RPC calls.',
  'tab.logs.desc': 'Live tail of the gateway file logs.',

  // Common actions
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.apply': 'Apply',
  'action.reset': 'Reset',
  'action.delete': 'Delete',
  'action.edit': 'Edit',
  'action.add': 'Add',
  'action.remove': 'Remove',
  'action.refresh': 'Refresh',
  'action.copy': 'Copy',
  'action.close': 'Close',
  'action.confirm': 'Confirm',
  'action.send': 'Send',
  'action.stop': 'Stop',
  'action.retry': 'Retry',

  // Status
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.connected': 'Connected',
  'status.disconnected': 'Disconnected',
  'status.loading': 'Loading...',
  'status.error': 'Error',
  'status.success': 'Success',
  'status.pending': 'Pending',
  'status.idle': 'Idle',
  'status.running': 'Running',
  'status.ok': 'OK',

  // Header
  'header.health': 'Health',
  'header.brand.title': 'MOLTBOT',
  'header.brand.sub': 'Gateway Dashboard',
  'header.expandSidebar': 'Expand sidebar',
  'header.collapseSidebar': 'Collapse sidebar',

  // Theme
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',

  // Chat
  'chat.placeholder': 'Type a message...',
  'chat.send': 'Send',
  'chat.thinking': 'Thinking...',
  'chat.attachFile': 'Attach file',
  'chat.clearHistory': 'Clear history',

  // Channels
  'channels.whatsapp': 'WhatsApp',
  'channels.telegram': 'Telegram',
  'channels.discord': 'Discord',
  'channels.slack': 'Slack',
  'channels.signal': 'Signal',
  'channels.imessage': 'iMessage',
  'channels.nostr': 'Nostr',
  'channels.googlechat': 'Google Chat',

  // Sessions
  'sessions.title': 'Sessions',
  'sessions.active': 'Active',
  'sessions.tokens': 'Tokens',
  'sessions.model': 'Model',
  'sessions.lastActivity': 'Last Activity',

  // Cron
  'cron.title': 'Cron Jobs',
  'cron.schedule': 'Schedule',
  'cron.nextRun': 'Next Run',
  'cron.lastRun': 'Last Run',
  'cron.enabled': 'Enabled',
  'cron.disabled': 'Disabled',
  'cron.addJob': 'Add Job',

  // Config
  'config.title': 'Configuration',
  'config.saved': 'Saved',
  'config.unsaved': 'Unsaved changes',
  'config.saveChanges': 'Save Changes',
  'config.discardChanges': 'Discard Changes',

  // Logs
  'logs.title': 'Logs',
  'logs.level': 'Level',
  'logs.filter': 'Filter',
  'logs.export': 'Export',
  'logs.clear': 'Clear',

  // Skills
  'skills.title': 'Skills',
  'skills.installed': 'Installed',
  'skills.available': 'Available',
  'skills.install': 'Install',
  'skills.uninstall': 'Uninstall',

  // Nodes
  'nodes.title': 'Nodes',
  'nodes.paired': 'Paired',
  'nodes.pending': 'Pending',
  'nodes.approve': 'Approve',
  'nodes.reject': 'Reject',

  // Errors
  'error.connection': 'Connection error',
  'error.timeout': 'Request timed out',
  'error.unknown': 'An unknown error occurred',
  'error.invalidInput': 'Invalid input',

  // Misc
  'misc.noData': 'No data',
  'misc.loading': 'Loading...',
  'misc.never': 'Never',
  'misc.justNow': 'Just now',
  'misc.ago': 'ago',
};
