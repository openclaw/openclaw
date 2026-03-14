import type { TranslationMap } from "../lib/types.ts";
import { pt_BR } from "./pt-BR.ts";

export const pt_PT: TranslationMap = {
  ...pt_BR,
  tabs: {
    ...(pt_BR.tabs as TranslationMap),
    appearance: "Aspeto e Configuração",
    language: "Idioma",
  },
  subtitles: {
    ...(pt_BR.subtitles as TranslationMap),
    appearance: "Definições de tema, interface e assistente de configuração.",
    language: "Escolha o idioma do dashboard.",
  },
  overview: {
    ...(pt_BR.overview as TranslationMap),
    access: {
      ...((pt_BR.overview as TranslationMap).access as TranslationMap),
      subtitle: "Onde o dashboard se liga e como se autentica.",
      sessionKey: "Chave de Sessão Predefinida",
      connectHint: "Clique em Ligar para aplicar as alterações de ligação.",
      trustedProxy: "Autenticado através de proxy fidedigno.",
    },
    snapshot: {
      ...((pt_BR.overview as TranslationMap).snapshot as TranslationMap),
      title: "Instantâneo",
      subtitle: "Informação mais recente do handshake do gateway.",
      uptime: "Tempo de Atividade",
      lastChannelsRefresh: "Última Atualização dos Canais",
    },
    notes: {
      ...((pt_BR.overview as TranslationMap).notes as TranslationMap),
      subtitle: "Lembretes rápidos para configurações de controlo remoto.",
    },
    auth: {
      ...((pt_BR.overview as TranslationMap).auth as TranslationMap),
      required:
        "Este gateway requer autenticação. Adicione um token ou palavra-passe e clique em Ligar.",
    },
    pairing: {
      ...((pt_BR.overview as TranslationMap).pairing as TranslationMap),
      hint: "Este dispositivo precisa de aprovação de emparelhamento do host do gateway.",
      mobileHint:
        "No telemóvel? Copie o URL completo (incluindo #token=...) executando openclaw dashboard --no-open no computador.",
    },
    connection: {
      ...((pt_BR.overview as TranslationMap).connection as TranslationMap),
      title: "Como ligar",
      step1: "Inicie o gateway na máquina anfitriã:",
      step2: "Obtenha um URL do painel com token:",
      step3: "Cole acima o URL do WebSocket e o token, ou abra diretamente o URL com token.",
      step4: "Ou gere um token reutilizável:",
      docsHint: "Para acesso remoto, recomendamos Tailscale Serve. ",
      docsLink: "Ler a documentação →",
    },
  },
  login: {
    ...(pt_BR.login as TranslationMap),
    subtitle: "Painel do Gateway",
    passwordPlaceholder: "opcional",
  },
  chat: {
    ...(pt_BR.chat as TranslationMap),
    disconnected: "Desligado do gateway.",
    hideCronSessions: "Ocultar sessões cron",
    showCronSessions: "Mostrar sessões cron",
    showCronSessionsHidden: "Mostrar sessões cron ({count} ocultas)",
  },
  languages: {
    ...(pt_BR.languages as TranslationMap),
    ptBR: "Português (Brasil)",
    ptPT: "Português (Portugal)",
  },
  languagePage: {
    title: "Idioma do dashboard",
    subtitle: "Escolha o idioma usado por este dashboard neste dispositivo.",
    currentLabel: "Idioma atual",
    localOnly: "A alteração é guardada de imediato neste navegador.",
    availableTitle: "Idiomas disponíveis",
    availableHint: "Pode trocar isto a qualquer momento pela barra lateral.",
    selectedBadge: "Selecionado",
    defaultBadge: "Predefinido",
    previewLabel: "Código regional",
  },
};
