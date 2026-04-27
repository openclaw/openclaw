export declare function sanitizeDoctorNote(note: string): string;
export declare function emitDoctorNotes(params: {
    note: (message: string, title?: string) => void;
    changeNotes?: string[];
    warningNotes?: string[];
}): void;
