---
summary: "Clinic overlay for HEARTBEAT.md"
read_when:
  - Every session
  - Heartbeat checks
---

# HEARTBEAT.md ÔÇö Painel Operacional da Clinica

> **Regra:** Lido TODA sessao. Mantenha ENXUTO (<100 linhas uteis).
> **Referencias:** Regras ÔåÆ `AGENTS.md` | Contatos ÔåÆ `CONTATOS.md` | Memoria ÔåÆ `MEMORY.md`

---

## ­ƒôè PAINEL EXECUTIVO (scan em 5s)

| ­ƒö┤ Urgente | ­ƒƒí Atencao | ­ƒƒó Monitorando |
| ------------ | ------------ | ---------------- |
| ÔÇö          | ÔÇö          | ÔÇö              |

---

## ­ƒôà AGENDA DO DIA

> **Fonte oficial:** Google Calendar (`gog calendar list`)
> **TTL:** Auto-expirar apos data.

| Horario   | Paciente | Tipo | Status                            | Notas |
| --------- | -------- | ---- | --------------------------------- | ----- |
| _(vazio)_ |          |      | _(confirmado/pendente/cancelado)_ |       |

---

## Ô£à CONFIRMACOES PENDENTES

> **Regra:** Confirmar 24h antes. Follow-up 4h antes se nao respondeu.

| Paciente  | Consulta | Horario | Confirmacao Enviada | Status                            |
| --------- | -------- | ------- | ------------------- | --------------------------------- |
| _(vazio)_ |          |         | _(sim/nao)_         | _(confirmado/pendente/cancelado)_ |

---

## ­ƒöä RETORNOS DO MES

> **Regra:** Lembrar 7d antes. Confirmar 1d antes. No-show ÔåÆ follow-up + alertar {{NOME_USUARIO}}.

| Paciente  | Tipo Tratamento | Retorno Previsto | Lembrete Enviado | Status |
| --------- | --------------- | ---------------- | ---------------- | ------ |
| _(vazio)_ |                 |                  |                  |        |

---

## ­ƒÆ░ COMPROVANTES PENDENTES

> **Regra:** Todo pagamento deve ter comprovante registrado.

| Paciente  | Valor | Data | Tipo                           | Registrado  |
| --------- | ----- | ---- | ------------------------------ | ----------- |
| _(vazio)_ |       |      | _(PIX/transferencia/dinheiro)_ | _(sim/nao)_ |

---

## ÔØî NO-SHOWS DA SEMANA

> **Regra:** 2+ no-shows ÔåÆ alertar {{NOME_USUARIO}} para definir politica.

| Paciente  | Data | Horario | Follow-up | Observacao |
| --------- | ---- | ------- | --------- | ---------- |
| _(vazio)_ |      |         |           |            |

---

## ­ƒôï FOLLOW-UPS DE ORCAMENTOS

> **TTL:** 7d sem resposta ÔåÆ follow-up. 14d ÔåÆ perguntar {{NOME_USUARIO}}.

| Paciente  | Orcamento | Valor | Enviado | Status                         |
| --------- | --------- | ----- | ------- | ------------------------------ |
| _(vazio)_ |           |       |         | _(aguardando/aceito/recusado)_ |

---

## ­ƒô× LISTA DE ESPERA

> Pacientes aguardando vaga por cancelamento/no-show.

| Paciente  | Preferencia Horario | Contato | Desde |
| --------- | ------------------- | ------- | ----- |
| _(vazio)_ |                     |         |       |

---

## ­ƒöü CRONS ATIVOS

| Cron       | Alvo | Freq | Contexto |
| ---------- | ---- | ---- | -------- |
| _(nenhum)_ |      |      |          |

---

## ­ƒöº TTL ÔÇö Regras de Auto-Higiene

1. **Agenda:** Consulta passou ÔåÆ registrar no daily log ÔåÆ deletar da tabela
2. **Confirmacoes:** Consulta passou ÔåÆ remover
3. **Retornos:** Compareceu ÔåÆ remover. No-show ÔåÆ registrar e manter
4. **Comprovantes:** Registrado ÔåÆ remover daqui
5. **No-shows:** Revisar semanalmente
6. **Orcamentos:** 14d sem resposta ÔåÆ consultar {{NOME_USUARIO}}
7. **Lista de espera:** Atendido ÔåÆ remover
8. **Tamanho:** Se > ~100 linhas uteis, mover para arquivos especificos
