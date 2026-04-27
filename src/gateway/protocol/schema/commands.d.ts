import { Type } from "typebox";
export declare const COMMAND_NAME_MAX_LENGTH = 200;
export declare const COMMAND_DESCRIPTION_MAX_LENGTH = 2000;
export declare const COMMAND_ALIAS_MAX_ITEMS = 20;
export declare const COMMAND_ARGS_MAX_ITEMS = 20;
export declare const COMMAND_ARG_NAME_MAX_LENGTH = 200;
export declare const COMMAND_ARG_DESCRIPTION_MAX_LENGTH = 500;
export declare const COMMAND_ARG_CHOICES_MAX_ITEMS = 50;
export declare const COMMAND_CHOICE_VALUE_MAX_LENGTH = 200;
export declare const COMMAND_CHOICE_LABEL_MAX_LENGTH = 200;
export declare const COMMAND_LIST_MAX_ITEMS = 500;
export declare const CommandSourceSchema: Type.TUnion<[Type.TLiteral<"native">, Type.TLiteral<"skill">, Type.TLiteral<"plugin">]>;
export declare const CommandScopeSchema: Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>;
export declare const CommandCategorySchema: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"options">, Type.TLiteral<"status">, Type.TLiteral<"management">, Type.TLiteral<"media">, Type.TLiteral<"tools">, Type.TLiteral<"docks">]>;
export declare const CommandArgChoiceSchema: Type.TObject<{
    value: Type.TString;
    label: Type.TString;
}>;
export declare const CommandArgSchema: Type.TObject<{
    name: Type.TString;
    description: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"string">, Type.TLiteral<"number">, Type.TLiteral<"boolean">]>;
    required: Type.TOptional<Type.TBoolean>;
    choices: Type.TOptional<Type.TArray<Type.TObject<{
        value: Type.TString;
        label: Type.TString;
    }>>>;
    dynamic: Type.TOptional<Type.TBoolean>;
}>;
export declare const CommandEntrySchema: Type.TObject<{
    name: Type.TString;
    nativeName: Type.TOptional<Type.TString>;
    textAliases: Type.TOptional<Type.TArray<Type.TString>>;
    description: Type.TString;
    category: Type.TOptional<Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"options">, Type.TLiteral<"status">, Type.TLiteral<"management">, Type.TLiteral<"media">, Type.TLiteral<"tools">, Type.TLiteral<"docks">]>>;
    source: Type.TUnion<[Type.TLiteral<"native">, Type.TLiteral<"skill">, Type.TLiteral<"plugin">]>;
    scope: Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>;
    acceptsArgs: Type.TBoolean;
    args: Type.TOptional<Type.TArray<Type.TObject<{
        name: Type.TString;
        description: Type.TString;
        type: Type.TUnion<[Type.TLiteral<"string">, Type.TLiteral<"number">, Type.TLiteral<"boolean">]>;
        required: Type.TOptional<Type.TBoolean>;
        choices: Type.TOptional<Type.TArray<Type.TObject<{
            value: Type.TString;
            label: Type.TString;
        }>>>;
        dynamic: Type.TOptional<Type.TBoolean>;
    }>>>;
}>;
export declare const CommandsListParamsSchema: Type.TObject<{
    agentId: Type.TOptional<Type.TString>;
    provider: Type.TOptional<Type.TString>;
    scope: Type.TOptional<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>>;
    includeArgs: Type.TOptional<Type.TBoolean>;
}>;
export declare const CommandsListResultSchema: Type.TObject<{
    commands: Type.TArray<Type.TObject<{
        name: Type.TString;
        nativeName: Type.TOptional<Type.TString>;
        textAliases: Type.TOptional<Type.TArray<Type.TString>>;
        description: Type.TString;
        category: Type.TOptional<Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"options">, Type.TLiteral<"status">, Type.TLiteral<"management">, Type.TLiteral<"media">, Type.TLiteral<"tools">, Type.TLiteral<"docks">]>>;
        source: Type.TUnion<[Type.TLiteral<"native">, Type.TLiteral<"skill">, Type.TLiteral<"plugin">]>;
        scope: Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"native">, Type.TLiteral<"both">]>;
        acceptsArgs: Type.TBoolean;
        args: Type.TOptional<Type.TArray<Type.TObject<{
            name: Type.TString;
            description: Type.TString;
            type: Type.TUnion<[Type.TLiteral<"string">, Type.TLiteral<"number">, Type.TLiteral<"boolean">]>;
            required: Type.TOptional<Type.TBoolean>;
            choices: Type.TOptional<Type.TArray<Type.TObject<{
                value: Type.TString;
                label: Type.TString;
            }>>>;
            dynamic: Type.TOptional<Type.TBoolean>;
        }>>>;
    }>>;
}>;
