# Especificacao de Placeholders

## Placeholders Padrao

Usados em todos os templates base. Preencha durante a primeira sessao via `BOOTSTRAP.md`.

| Placeholder         | Descricao                  | Exemplo                                  | Onde Aparece                                      |
| ------------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `{{NOME_IA}}`       | Nome da assistente IA      | Luna, Iris, Atlas                        | SOUL.md, IDENTITY.md, BOOTSTRAP.md                |
| `{{EMOJI_IA}}`      | Emoji da assistente        | ­ƒîÖ, ­ƒîê, ­ƒù║´©Å                      | SOUL.md, IDENTITY.md, BOOTSTRAP.md                |
| `{{PERSONALIDADE}}` | Descricao da personalidade | "Calorosa e proativa, com humor sutil"   | SOUL.md                                           |
| `{{NOME_USUARIO}}`  | Nome do dono/administrador | Lucas, Maria, Carlos                     | USER.md, AGENTS.md, HEARTBEAT.md, CONTATOS.md     |
| `{{EMPRESA_NOME}}`  | Nome da empresa            | Clinica Dr. Rodrigo                      | USER.md                                           |
| `{{EMPRESA_CNPJ}}`  | CNPJ da empresa            | 12.345.678/0001-90                       | USER.md                                           |
| `{{NUMERO_ADMIN}}`  | WhatsApp do admin          | +5569XXXXXXXX                            | AGENTS.md, CONTATOS.md, SECURITY.md, HEARTBEAT.md |
| `{{TIMEZONE}}`      | Timezone                   | America/Sao_Paulo                        | USER.md, TOOLS.md, HEARTBEAT-GUIDE.md             |
| `{{IDIOMA}}`        | Idioma principal           | Portugues                                | USER.md                                           |
| `{{SEGMENTO}}`      | Segmento de atuacao        | clinic, personal, construction, law-firm | USER.md                                           |

## Placeholders por Segmento

### clinic

| Placeholder          | Descricao                 | Exemplo |
| -------------------- | ------------------------- | ------- |
| `{{VALOR_CONSULTA}}` | Valor da consulta inicial | R$600   |

## Formato

- Placeholders usam chaves duplas: `{{NOME}}`
- Case-sensitive: `{{NOME_IA}}` != `{{nome_ia}}`
- Substituicao e literal (find & replace)
- Placeholders nao preenchidos permanecem como `{{PLACEHOLDER}}` nos arquivos

## Preenchimento

Os placeholders sao preenchidos de duas formas:

1. **Via BOOTSTRAP.md:** Na primeira sessao, a IA le o BOOTSTRAP.md e pergunta ao usuario os valores
2. **Manualmente:** O usuario edita os arquivos e substitui os placeholders

O setup NAO substitui automaticamente ÔÇö isso permite que a IA ajude no preenchimento de forma conversacional.
