import type { TranslationKeys } from '../types';

export const zhCN: TranslationKeys = {
  // Navigation groups
  'nav.chat': '聊天',
  'nav.control': '控制',
  'nav.agent': '代理',
  'nav.settings': '设置',

  // Tab titles
  'tab.overview': '概览',
  'tab.channels': '通道',
  'tab.instances': '实例',
  'tab.sessions': '会话',
  'tab.cron': '定时任务',
  'tab.skills': '技能',
  'tab.nodes': '节点',
  'tab.chat': '聊天',
  'tab.config': '配置',
  'tab.debug': '调试',
  'tab.logs': '日志',

  // Tab subtitles/descriptions
  'tab.overview.desc': '网关状态、入口点和快速健康检查。',
  'tab.channels.desc': '管理通道和设置。',
  'tab.instances.desc': '来自已连接客户端和节点的状态信标。',
  'tab.sessions.desc': '检查活跃会话并调整每会话默认设置。',
  'tab.cron.desc': '安排唤醒和定期代理运行。',
  'tab.skills.desc': '管理技能可用性和 API 密钥注入。',
  'tab.nodes.desc': '已配对设备、功能和命令暴露。',
  'tab.chat.desc': '直接网关聊天会话，用于快速干预。',
  'tab.config.desc': '安全编辑 ~/.clawdbot/clawdbot.json。',
  'tab.debug.desc': '网关快照、事件和手动 RPC 调用。',
  'tab.logs.desc': '实时查看网关文件日志。',

  // Common actions
  'action.save': '保存',
  'action.cancel': '取消',
  'action.apply': '应用',
  'action.reset': '重置',
  'action.delete': '删除',
  'action.edit': '编辑',
  'action.add': '添加',
  'action.remove': '移除',
  'action.refresh': '刷新',
  'action.copy': '复制',
  'action.close': '关闭',
  'action.confirm': '确认',
  'action.send': '发送',
  'action.stop': '停止',
  'action.retry': '重试',

  // Status
  'status.online': '在线',
  'status.offline': '离线',
  'status.connected': '已连接',
  'status.disconnected': '已断开',
  'status.loading': '加载中...',
  'status.error': '错误',
  'status.success': '成功',
  'status.pending': '等待中',
  'status.idle': '空闲',
  'status.running': '运行中',
  'status.ok': '正常',

  // Header
  'header.health': '健康状态',
  'header.brand.title': 'MOLTBOT',
  'header.brand.sub': '网关控制台',
  'header.expandSidebar': '展开侧边栏',
  'header.collapseSidebar': '收起侧边栏',

  // Theme
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '跟随系统',

  // Chat
  'chat.placeholder': '输入消息...',
  'chat.send': '发送',
  'chat.thinking': '思考中...',
  'chat.attachFile': '添加附件',
  'chat.clearHistory': '清除历史',

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
  'sessions.title': '会话',
  'sessions.active': '活跃',
  'sessions.tokens': 'Token 数',
  'sessions.model': '模型',
  'sessions.lastActivity': '最后活动',

  // Cron
  'cron.title': '定时任务',
  'cron.schedule': '调度',
  'cron.nextRun': '下次运行',
  'cron.lastRun': '上次运行',
  'cron.enabled': '已启用',
  'cron.disabled': '已禁用',
  'cron.addJob': '添加任务',

  // Config
  'config.title': '配置',
  'config.saved': '已保存',
  'config.unsaved': '有未保存的更改',
  'config.saveChanges': '保存更改',
  'config.discardChanges': '放弃更改',

  // Logs
  'logs.title': '日志',
  'logs.level': '级别',
  'logs.filter': '筛选',
  'logs.export': '导出',
  'logs.clear': '清空',

  // Skills
  'skills.title': '技能',
  'skills.installed': '已安装',
  'skills.available': '可用',
  'skills.install': '安装',
  'skills.uninstall': '卸载',

  // Nodes
  'nodes.title': '节点',
  'nodes.paired': '已配对',
  'nodes.pending': '等待中',
  'nodes.approve': '批准',
  'nodes.reject': '拒绝',

  // Errors
  'error.connection': '连接错误',
  'error.timeout': '请求超时',
  'error.unknown': '发生未知错误',
  'error.invalidInput': '输入无效',

  // Misc
  'misc.noData': '暂无数据',
  'misc.loading': '加载中...',
  'misc.never': '从未',
  'misc.justNow': '刚刚',
  'misc.ago': '前',
};
