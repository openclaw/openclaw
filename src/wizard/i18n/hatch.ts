export type HatchTranslations = {
  hatchIntro: {
    definingAction: string;
    takeYourTime: string;
    tellMore: string;
    willSend: string;
    title: string;
  };
  hatchChoice: {
    question: string;
    tuiOption: string;
    webOption: string;
    laterOption: string;
  };
  wakeMessage: string;
  token: {
    description: string;
    stored: string;
    webUiKeeps: string;
    ifPrompted: string;
    title: string;
  };
  dashboard: {
    opened: string;
    copyPaste: string;
    title: string;
  };
  later: {
    whenReady: string;
    title: string;
  };
};

export const en: HatchTranslations = {
  hatchIntro: {
    definingAction: "This is the defining action that makes your agent you.",
    takeYourTime: "Please take your time.",
    tellMore: "The more you tell it, the better the experience will be.",
    willSend: 'We will send: "Wake up, my friend!"',
    title: "Start TUI (best option!)",
  },
  hatchChoice: {
    question: "How do you want to hatch your bot?",
    tuiOption: "Hatch in TUI (recommended)",
    webOption: "Open the Web UI",
    laterOption: "Do this later",
  },
  wakeMessage: "Wake up, my friend!",
  token: {
    description: "Gateway token: shared auth for the Gateway + Control UI.",
    stored: "Stored in: ~/.openclaw/openclaw.json (gateway.auth.token) or OPENCLAW_GATEWAY_TOKEN.",
    webUiKeeps: "Web UI keeps dashboard URL tokens in memory for the current tab and strips them from the URL after load.",
    ifPrompted: "If prompted: paste the token into Control UI settings (or use the tokenized dashboard URL).",
    title: "Token",
  },
  dashboard: {
    opened: "Opened in your browser. Keep that tab to control OpenClaw.",
    copyPaste: "Copy/paste this URL in a browser on this machine to control OpenClaw.",
    title: "Dashboard ready",
  },
  later: {
    whenReady: "When you're ready: {command}",
    title: "Later",
  },
};

export const zhCN: HatchTranslations = {
  hatchIntro: {
    definingAction: "这是定义你的 Agent 身份的关键时刻。",
    takeYourTime: "请慢慢来。",
    tellMore: "你告诉它的越多，体验就会越好。",
    willSend: '我们将发送："醒来吧，我的朋友！"',
    title: "启动 TUI（最佳选择！）",
  },
  hatchChoice: {
    question: "你想如何孵化你的机器人？",
    tuiOption: "在 TUI 中孵化（推荐）",
    webOption: "打开 Web UI",
    laterOption: "稍后再做",
  },
  wakeMessage: "醒来吧，我的朋友！",
  token: {
    description: "Gateway 令牌：Gateway 和 Control UI 的共享认证。",
    stored: "存储位置：~/.openclaw/openclaw.json (gateway.auth.token) 或 OPENCLAW_GATEWAY_TOKEN。",
    webUiKeeps: "Web UI 将仪表板 URL 令牌保存在当前标签页的内存中，加载后会从 URL 中移除。",
    ifPrompted: "如果提示：将令牌粘贴到 Control UI 设置中（或使用带令牌的仪表板 URL）。",
    title: "令牌",
  },
  dashboard: {
    opened: "已在浏览器中打开。保持该标签页以控制 OpenClaw。",
    copyPaste: "在本机浏览器中复制/粘贴此 URL 以控制 OpenClaw。",
    title: "仪表板就绪",
  },
  later: {
    whenReady: "准备好后：{command}",
    title: "稍后",
  },
};
