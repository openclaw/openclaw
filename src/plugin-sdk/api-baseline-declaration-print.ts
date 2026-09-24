// Declaration printing keeps compiler-rendered public SDK signatures stable.
import * as ts from "typescript/unstable/ast";
import * as factory from "typescript/unstable/ast/factory";
import {
  NodeBuilderFlags,
  SignatureKind,
  type Checker,
  type Emitter,
  type Type,
} from "typescript/unstable/sync";
import { normalizePluginSdkApiDeclarationText } from "./api-baseline-normalization.js";

const DECLARATION_TYPE_FORMAT_FLAGS =
  NodeBuilderFlags.NoTruncation | NodeBuilderFlags.MultilineObjectLiterals;
const DECLARATION_NODE_BUILDER_FLAGS = NodeBuilderFlags.NoTruncation;

function declarationModifiers(node: ts.ModifiersBase): readonly ts.Modifier[] | undefined {
  return node.modifiers?.filter(ts.isModifier);
}

function declarationType(checker: Checker, declaration: ts.Node): Type {
  const type = checker.getTypeAtLocation(declaration);
  if (!type) {
    throw new Error(
      `Unable to resolve declaration type in ${declaration.getSourceFile().fileName}`,
    );
  }
  return type;
}

function inferDeclarationTypeNode(
  checker: Checker,
  declaration: ts.Declaration,
  explicitType: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  return (
    explicitType ??
    checker.typeToTypeNode(
      declarationType(checker, declaration),
      declaration,
      DECLARATION_NODE_BUILDER_FLAGS,
    )
  );
}

function inferDeclarationReturnTypeNode(
  checker: Checker,
  declaration: ts.FunctionLikeDeclaration,
  explicitType: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (explicitType) {
    return explicitType;
  }
  const signature = checker.getSignatureFromDeclaration(declaration);
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  return returnType
    ? checker.typeToTypeNode(returnType, declaration, DECLARATION_NODE_BUILDER_FLAGS)
    : undefined;
}

function stripParameterInitializer(parameter: ts.ParameterDeclaration): ts.ParameterDeclaration {
  return factory.updateParameterDeclaration(
    parameter,
    declarationModifiers(parameter),
    parameter.dotDotDotToken,
    parameter.name,
    parameter.questionToken,
    parameter.type,
    undefined,
  );
}

function stripClassMemberImplementation(
  checker: Checker,
  member: ts.ClassElement,
): ts.ClassElement | null {
  if (ts.isClassStaticBlockDeclaration(member)) {
    return null;
  }
  if (ts.isConstructorDeclaration(member)) {
    return factory.updateConstructorDeclaration(
      member,
      declarationModifiers(member),
      member.typeParameters,
      member.parameters.map(stripParameterInitializer),
      member.type,
      undefined,
    );
  }
  if (ts.isMethodDeclaration(member)) {
    return factory.updateMethodDeclaration(
      member,
      declarationModifiers(member),
      member.asteriskToken,
      member.name,
      member.postfixToken,
      member.typeParameters,
      member.parameters.map(stripParameterInitializer),
      inferDeclarationReturnTypeNode(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return factory.updateGetAccessorDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.typeParameters,
      member.parameters.map(stripParameterInitializer),
      inferDeclarationReturnTypeNode(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return factory.updateSetAccessorDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.typeParameters,
      member.parameters.map(stripParameterInitializer),
      member.type,
      undefined,
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    return factory.updatePropertyDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.postfixToken,
      inferDeclarationTypeNode(checker, member, member.type),
      undefined,
    );
  }
  return member;
}

function stripClassImplementation(
  checker: Checker,
  declaration: ts.ClassDeclaration,
  exportName: string,
): ts.ClassDeclaration {
  const members = declaration.members.flatMap((member) => {
    const stripped = stripClassMemberImplementation(checker, member);
    return stripped ? [stripped] : [];
  });
  return factory.updateClassDeclaration(
    declaration,
    declarationModifiers(declaration),
    factory.createIdentifier(exportName),
    declaration.typeParameters,
    declaration.heritageClauses,
    members,
  );
}

function renameStructuredDeclarationForExport(
  checker: Checker,
  declaration: ts.Declaration,
  exportName: string,
): ts.Declaration {
  const name = factory.createIdentifier(exportName);
  if (ts.isClassDeclaration(declaration)) {
    return stripClassImplementation(checker, declaration, exportName);
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return factory.updateInterfaceDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.typeParameters,
      declaration.heritageClauses,
      declaration.members,
    );
  }
  if (ts.isEnumDeclaration(declaration)) {
    return factory.updateEnumDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.members,
    );
  }
  if (ts.isModuleDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return factory.updateModuleDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.body,
    );
  }
  return declaration;
}

function ensureExportedDeclarationText(value: string): string {
  return /^export\b/u.test(value) ? value : `export ${value}`;
}

function printTypeParameters(printer: Emitter, declaration: ts.TypeAliasDeclaration): string {
  if (!declaration.typeParameters?.length) {
    return "";
  }
  const parameters = declaration.typeParameters.map((typeParameter) =>
    printer.printNode(typeParameter).trim(),
  );
  return `<${parameters.join(", ")}>`;
}

/** Render tuple-derived literal unions in declaration order, independent of compiler traversal. */
export function formatPluginSdkApiTypeAlias(
  checker: Checker,
  declaration: ts.TypeAliasDeclaration,
): string {
  const type = declarationType(checker, declaration);
  if (
    type.isUnionType() &&
    ts.isIndexedAccessTypeNode(declaration.type) &&
    declaration.type.indexType.kind === ts.SyntaxKind.NumberKeyword
  ) {
    const tuple = checker.getTypeFromTypeNode(declaration.type.objectType);
    const members =
      tuple?.isTypeReference() && checker.isTupleType(tuple)
        ? [...new Set(checker.getTypeArguments(tuple))]
        : [];
    if (
      members.length === type.getTypes().length &&
      members.every(
        (member) =>
          (member.isStringLiteralType() || member.isNumberLiteralType()) &&
          type.getTypes().includes(member),
      )
    ) {
      return members
        .map((member) => checker.typeToString(member, declaration, DECLARATION_TYPE_FORMAT_FLAGS))
        .join(" | ");
    }
  }
  return checker.typeToString(type, declaration, DECLARATION_TYPE_FORMAT_FLAGS);
}

export function printPluginSdkExportDeclaration(
  repoRoot: string,
  checker: Checker,
  printer: Emitter,
  declaration: ts.Declaration,
  exportName: string,
): string | null {
  if (ts.isFunctionDeclaration(declaration)) {
    const signatures = checker.getSignaturesOfType(
      declarationType(checker, declaration),
      SignatureKind.Call,
    );
    if (signatures.length === 0) {
      return `export function ${exportName}();`;
    }
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      signatures
        .map((signature) => {
          const rendered = checker.signatureToSignatureDeclaration(
            signature,
            ts.SyntaxKind.FunctionDeclaration,
            declaration,
            DECLARATION_TYPE_FORMAT_FLAGS,
          );
          if (!rendered || !ts.isFunctionDeclaration(rendered)) {
            throw new Error(`Unable to print Plugin SDK function ${exportName}`);
          }
          return printer
            .printNode(
              factory.updateFunctionDeclaration(
                rendered,
                [factory.createToken(ts.SyntaxKind.ExportKeyword)],
                undefined,
                factory.createIdentifier(exportName),
                rendered.typeParameters,
                rendered.parameters,
                rendered.type,
                undefined,
              ),
            )
            .trim();
        })
        .join("\n"),
    );
  }

  if (ts.isVariableDeclaration(declaration)) {
    const type = declarationType(checker, declaration);
    const prefix =
      declaration.parent && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export ${prefix} ${exportName}: ${checker.typeToString(
        type,
        declaration,
        DECLARATION_TYPE_FORMAT_FLAGS,
      )};`,
    );
  }

  if (ts.isTypeAliasDeclaration(declaration)) {
    const typeParameters = printTypeParameters(printer, declaration);
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export type ${exportName}${typeParameters} = ${formatPluginSdkApiTypeAlias(checker, declaration)};`,
    );
  }

  const printableDeclaration = renameStructuredDeclarationForExport(
    checker,
    declaration,
    exportName,
  );
  const text = printer.printNode(printableDeclaration).trim();
  if (!text) {
    return null;
  }
  return normalizePluginSdkApiDeclarationText(repoRoot, ensureExportedDeclarationText(text));
}
