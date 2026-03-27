import { ExperienceRecord } from './types';
import { ExperienceStorage } from './storage';
import { ExperienceAbstraction } from './abstraction';
import { ExperienceFilter } from './filter';

export class ExperienceSystem {
  private storage: ExperienceStorage;
  private abstraction: ExperienceAbstraction;
  private filter: ExperienceFilter;

  constructor() {
    this.storage = new ExperienceStorage();
    this.abstraction = new ExperienceAbstraction();
    this.filter = new ExperienceFilter();
  }

  /**
   * Records a new experience session with context
   */
  async recordExperience(session: ExperienceRecord): Promise<void> {
    await this.storage.save(session);
  }

  /**
   * Queries similar past experiences based on context
   */
  async querySimilarExperiences(context: Record<string, any>, limit: number = 10): Promise<ExperienceRecord[]> {
    const allExperiences = await this.storage.getAll();
    const filteredExperiences = this.filter.apply(allExperiences, context);
    return filteredExperiences.slice(0, limit);
  }

  /**
   * Abstracts patterns from specific experiences
   */
  async abstractPatterns(experiences: ExperienceRecord[]): Promise<Record<string, any>> {
    return this.abstraction.generate(experiences);
  }

  /**
   * Manages experience quality filtering
   */
  filterExperiences(experiences: ExperienceRecord[]): ExperienceRecord[] {
    return this.filter.apply(experiences);
  }

  /**
   * Handles experience sharing
   */
  async shareExperience(experienceId: string, target: string): Promise<void> {
    const experience = await this.storage.get(experienceId);
    if (!experience) {
      throw new Error(`Experience with id ${experienceId} not found`);
    }
    // Implementation for sharing logic
    console.log(`Sharing experience ${experienceId} with ${target}`);
  }
}

export * from './types';
export * from './storage';
export * from './abstraction';
export * from './filter';