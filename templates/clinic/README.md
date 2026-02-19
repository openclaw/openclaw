# Template: Clinica Medica/Odontologica

## Para Quem

Clinicas medicas e odontologicas que precisam de um assistente IA para:

- Agendamento e confirmacao de consultas
- Gestao de retornos de pacientes
- Controle de no-shows
- Registro de comprovantes de pagamento
- Follow-up de orcamentos
- Lista de espera

## Baseado em Caso Real

Este template foi criado com base nas dores reais de uma clinica odontologica:

- Zero digital (prontuarios fisicos, comprovantes perdidos no WhatsApp)
- Agendamento manual (secretaria gerencia tudo na cabeca)
- No-shows sem controle
- Retornos esquecidos
- Orcamentos sem follow-up

## Arquivos do Overlay

| Arquivo      | O que Muda do Base                                                                         |
| ------------ | ------------------------------------------------------------------------------------------ |
| SOUL.md      | Tom profissional saude, acolhedor, sigilo medico                                           |
| AGENTS.md    | LGPD saude, protocolo agendamento, regra anti-diagnostico, registro comprovantes           |
| HEARTBEAT.md | Agenda do dia, confirmacoes, retornos, comprovantes, no-shows, orcamentos, lista de espera |
| CONTATOS.md  | Categorias: Pacientes, Convenios, Fornecedores, Equipe                                     |

## Placeholders Especificos

| Placeholder          | Exemplo                  |
| -------------------- | ------------------------ |
| `{{VALOR_CONSULTA}}` | R$600 (consulta inicial) |

## Regras Especiais

1. **LGPD Saude:** Dados de pacientes sao sensiveis. Nunca compartilhar entre pacientes.
2. **Anti-diagnostico:** A IA NUNCA da diagnostico, tratamento ou prescricao.
3. **Confirmacao 24h:** Toda consulta deve ser confirmada 24h antes.
4. **Retornos:** Lembrete 7d antes + confirmacao 1d antes.
5. **Comprovantes:** Todo pagamento deve ser registrado.
