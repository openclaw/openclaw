---
summary: "Workspace template for HEARTBEAT.md (OpenClaw segment base)"
read_when:
  - Every session
  - Heartbeat checks
---

# HEARTBEAT.md ��� Painel Operacional

> **Regra:** Lido TODA sessao. Mantenha ENXUTO (<100 linhas uteis).
> **Referencias:** Regras ��� `AGENTS.md` | Pessoas ��� `CONTATOS.md` | Memoria ��� `MEMORY.md` + `memory/`

---

## ���� PAINEL EXECUTIVO (scan em 5s)

| ���� Urgente | ���� Atencao | ���� Monitorando |
| ------------ | ------------ | ---------------- |
| ���          | ���          | ���              |

---

## ���� AGENDA

> **Fonte oficial:** Google Calendar (`gog calendar list`)
> **Cache aqui:** So proximos 2-3 dias. Sempre registrar novos eventos no Calendar via gog.
> **TTL:** Auto-expirar apos data. Evento passou ��� registrar no daily log ��� deletar daqui.

| Data      | Hora | Evento | Notas |
| --------- | ---- | ------ | ----- |
| _(vazio)_ |      |        |       |

---

## ���� FOLLOW-UPS ATIVOS

> **TTL:** Revisar a cada 7d. Sem progresso em 14d ��� escalar para {{NOME_USUARIO}}.
> **Resolvido ���** remover daqui, registrar no daily log.

| Pessoa    | Assunto | Status | Desde | Proxima Acao |
| --------- | ------- | ------ | ----- | ------------ |
| _(vazio)_ |         |        |       |              |

---

## ���� PROJETOS ATIVOS

> **TTL:** Ate milestone. Concluido ��� mover resumo para `MEMORY.md`, detalhes ficam em `memory/projetos/`.

_(Nenhum projeto ativo ainda)_

---

## ���� TAREFAS PENDENTES

> **TTL:** Revisar a cada 14d. Sem progresso ��� perguntar {{NOME_USUARIO}} se descarta ou reprioriza.

| #         | Tarefa | Contexto | Adicionado |
| --------- | ------ | -------- | ---------- |
| _(vazio)_ |        |          |            |

---

## ���� CRONS ATIVOS

> **TTL:** Ate desativacao explicita por {{NOME_USUARIO}}.

| Cron       | Alvo | Freq | Contexto |
| ---------- | ---- | ---- | -------- |
| _(nenhum)_ |      |      |          |

---

## ��� FOLLOW-UP AUTOMATICO

> **Regra:** A cada heartbeat, checar `memory/YYYY-MM-DD.md` secao "Mensagens Pendentes de Resposta".

**Checklist do heartbeat:**

1. Ler daily log de hoje, buscar linhas com �Ŧ
2. Para cada �Ŧ com mais de 3h desde envio (e follow-ups < 2): enviar follow-up
3. Para cada �Ŧ com follow-ups >= 2: marcar ��� e escalar pro {{NOME_USUARIO}}
4. Msgs enviadas apos 15h: so cobrar no dia seguinte a partir de 9h
5. Atualizar contador de follow-ups no daily log apos enviar

**Templates de follow-up:**

- FU#1: "Oi [nome]! ���� Mandei uma mensagem mais cedo sobre [assunto]. Conseguiu ver? Quando puder me dar um retorno, agradeco!"
- FU#2: "[Nome], preciso de um retorno sobre [assunto] pra dar andamento. Pode me responder hoje? ����"
- Escalada: Avisar {{NOME_USUARIO}} via message tool com contexto completo

---

## ���� TTL ��� Regras de Auto-Higiene

1. **Agenda:** Evento passou ��� ԣ� no daily log ��� deletar da tabela
2. **Follow-ups:** 7d sem update ��� cobrar de novo ou perguntar {{NOME_USUARIO}}
3. **Follow-ups:** Resolvido ��� remover, registrar desfecho no daily log
4. **Projetos:** Milestone ��� atualizar. Concluido ��� resumo no `MEMORY.md`, remover daqui
5. **Tarefas:** 14d sem progresso ��� perguntar {{NOME_USUARIO}}: manter ou descartar?
6. **Crons:** So {{NOME_USUARIO}} ativa/desativa
7. **Painel Executivo:** Atualizar SEMPRE que mudar qualquer secao abaixo
8. **Tamanho:** Se HEARTBEAT.md > ~100 linhas uteis, algo precisa ser movido ou arquivado
