# Guia de Heartbeats

## Conceito

Heartbeats sao oportunidades de ser proativa! Nao so responder `HEARTBEAT_OK`.

## Heartbeat vs Cron

**Heartbeat quando:**

- Multiplos checks juntos (inbox + calendar + notifications)
- Precisa contexto conversacional
- Timing pode variar (~30 min)
- Reduzir API calls

**Cron quando:**

- Timing exato ("9h sharp toda segunda")
- Isolamento do historico
- Model/thinking diferente
- One-shot reminders
- Output direto pro canal

**Tip:** Batch checks similares no HEARTBEAT.md ao inves de multiplos crons.

## O que Checar (rotacionar, 2-4x/dia)

- **Emails** - Urgentes nao lidos?
- **Calendar** - Eventos em 24-48h?
- **Follow-ups** - Pendencias com mais de 3h?

## Quando Falar

- Email importante chegou
- Evento proximo (<2h)
- Algo interessante encontrado
- > 8h desde ultimo contato

## Quando Silencio (HEARTBEAT_OK)

- Noite (23h-08h) exceto urgente
- Usuario ocupado
- Nada novo desde ultimo check
- Checou <30 min atras

## Trabalho Proativo (sem perguntar)

- Organizar arquivos de memoria
- Checar projetos (git status)
- Atualizar documentacao
- Review MEMORY.md

## ­ƒöä Manutencao de Memoria

A cada poucos dias, durante heartbeat:

1. Ler `memory/YYYY-MM-DD.md` recentes
2. Identificar eventos/licoes significativas
3. Atualizar MEMORY.md com aprendizados
4. Remover info desatualizada

Daily files = notas brutas
MEMORY.md = sabedoria curada

---

## ÔÅ░ Tipos de Cron: systemEvent vs agentTurn

### systemEvent (sessionTarget: "main")

Injeta texto na sessao principal. Bom pra lembretes internos ao agente.

```json
{
  "name": "check-emails-manha",
  "schedule": { "kind": "cron", "expr": "0 8 * * 1-5", "tz": "{{TIMEZONE}}" },
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",
    "text": "Lembrete: verificar emails e calendar."
  }
}
```

### isolated agentTurn (sessionTarget: "isolated")

Roda em sessao separada com delivery configurado. Bom pra enviar mensagens.

```json
{
  "name": "lembrete-diario",
  "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "{{TIMEZONE}}" },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "Enviar bom dia e resumo do dia."
  },
  "delivery": {
    "mode": "announce",
    "channel": "whatsapp",
    "to": "{{NUMERO_ADMIN}}"
  }
}
```

|                      | systemEvent        | isolated agentTurn            |
| -------------------- | ------------------ | ----------------------------- |
| Onde roda            | Sessao principal   | Sessao separada               |
| Envia mensagem       | Nao                | Sim (via delivery)            |
| Precisa sessao ativa | Sim                | Nao                           |
| Bom pra              | Lembretes internos | Mensagens e tarefas autonomas |
