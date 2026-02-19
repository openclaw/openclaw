# Sistema de Templates OpenClaw

Templates pre-configurados por segmento para setup rapido de novos clientes.

## Arquitetura: Base + Overlay

```
templates/
  base/           -> Arquivos universais com {{PLACEHOLDERS}}
  clinic/         -> Overlay: clinica medica/odontologica
  personal/       -> Overlay: uso pessoal
  construction/   -> Overlay: construtora/incorporadora
  law-firm/       -> Overlay: escritorio de advocacia
```

**Fluxo:** Copia `base/` ��� Sobrescreve com overlay do segmento ��� Escreve no workspace

Arquivos do overlay substituem os do base. Arquivos que nao existem no overlay usam o base.

## Uso

```bash
# Setup com template especifico
openclaw setup --template clinic --workspace ~/cliente-dr-rodrigo

# Setup interativo (menu de escolha)
openclaw setup

# Setup padrao (sem template de segmento)
openclaw setup --template default
```

## Placeholders

Os templates usam placeholders `{{NOME}}` que devem ser preenchidos manualmente ou via `BOOTSTRAP.md` na primeira sessao. Ver `_template-spec.md` para lista completa.

## Segmentos Disponiveis

| Segmento     | Diretorio          | Descricao                                      |
| ------------ | ------------------ | ---------------------------------------------- |
| clinic       | `clinic/`          | Clinicas medicas e odontologicas               |
| personal     | `personal/`        | Uso pessoal (agenda, lembretes, produtividade) |
| construction | `construction/`    | Construtoras e incorporadoras                  |
| law-firm     | `law-firm/`        | Escritorios de advocacia                       |
| default      | _(nenhum overlay)_ | Templates genericos do OpenClaw                |

## Criando Novos Segmentos

1. Crie pasta em `templates/{segmento}/`
2. Adicione os arquivos .md que DIFEREM do base (overlay)
3. Crie `README.md` documentando o segmento
4. Registre no select do `src/commands/setup.ts`
