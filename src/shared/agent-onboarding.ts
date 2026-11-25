import type { Locale } from "./control-ui-locale.js";

// This introduction is saved by the Gateway before the first model turn. It is
// conversation history, not browser chrome: every viewer sees the same text.
const introductions = {
  en: ["Hi, I’m {name}. Happy to help.", "Hi! Happy to help."],
  "zh-CN": ["你好，我是{name}。很高兴为你提供帮助。", "你好！很高兴为你提供帮助。"],
  "zh-TW": ["你好，我是{name}。很高興能幫上忙。", "你好！很高興能幫上忙。"],
  "pt-BR": ["Olá, sou {name}. Estou aqui para ajudar.", "Olá! Estou aqui para ajudar."],
  de: ["Hallo, ich bin {name}. Ich helfe dir gerne.", "Hallo! Ich helfe dir gerne."],
  es: ["Hola, soy {name}. Estoy aquí para ayudarte.", "¡Hola! Estoy aquí para ayudarte."],
  "ja-JP": ["こんにちは、{name}です。お手伝いします。", "こんにちは！お手伝いします。"],
  ko: ["안녕하세요, {name}입니다. 기꺼이 도와드릴게요.", "안녕하세요! 기꺼이 도와드릴게요."],
  fr: [
    "Bonjour, je m’appelle {name}. Je suis là pour vous aider.",
    "Bonjour ! Je suis là pour vous aider.",
  ],
  hi: ["नमस्ते, मेरा नाम {name} है। मैं आपकी मदद के लिए यहाँ हूँ।", "नमस्ते! मैं आपकी मदद के लिए यहाँ हूँ।"],
  ar: ["مرحبًا، أنا {name}. يسعدني مساعدتك.", "مرحبًا! يسعدني مساعدتك."],
  it: ["Ciao, sono {name}. Sono qui per aiutarti.", "Ciao! Sono qui per aiutarti."],
  tr: [
    "Merhaba, ben {name}. Yardım etmek için buradayım.",
    "Merhaba! Yardım etmek için buradayım.",
  ],
  uk: ["Вітаю, мене звати {name}. Я тут, щоб допомогти.", "Вітаю! Я тут, щоб допомогти."],
  id: ["Halo, saya {name}. Saya siap membantu.", "Halo! Saya siap membantu."],
  pl: ["Cześć, mam na imię {name}. Chętnie pomogę.", "Cześć! Chętnie pomogę."],
  th: ["สวัสดี ฉันชื่อ {name} ยินดีช่วยเหลือคุณ", "สวัสดี! ยินดีช่วยเหลือคุณ"],
  vi: ["Xin chào, mình là {name}. Mình sẵn sàng giúp bạn.", "Xin chào! Mình sẵn sàng giúp bạn."],
  nl: ["Hallo, ik ben {name}. Ik help je graag.", "Hallo! Ik help je graag."],
  fa: ["سلام، من {name} هستم. خوشحال می‌شوم کمکتان کنم.", "سلام! خوشحال می‌شوم کمکتان کنم."],
  ru: [
    "Здравствуйте, меня зовут {name}. Я здесь, чтобы помочь.",
    "Здравствуйте! Я здесь, чтобы помочь.",
  ],
  sv: ["Hej, jag heter {name}. Jag hjälper gärna till.", "Hej! Jag hjälper gärna till."],
  ca: ["Hola, soc {name}. Soc aquí per ajudar-te.", "Hola! Soc aquí per ajudar-te."],
} satisfies Record<Locale, [string, string]>;

export function buildAgentOnboardingGreeting(
  agentName: string | undefined,
  locale: Locale,
): string {
  const name = agentName?.trim();
  const [named, unnamed] = introductions[locale];
  return name ? named.replace("{name}", () => name) : unnamed;
}
